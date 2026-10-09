import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const PORT = process.env.API_PORT || process.env.PORT || 3334
const ADOBE_STOCK_ACTOR_ID = 'kawsar~adobe-stock-scraper'
const APIFY_MAX_ITEMS = 1000
const APIFY_DEFAULT_PAGE_SIZE = 25
const APIFY_MAX_PAGE_SIZE = 100
const APIFY_TIMEOUT_MS = 90_000
const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'])
const FAILED_RUN_STATUSES = new Set(['FAILED', 'ABORTED', 'TIMED-OUT'])

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
app.use(express.json({ limit: '10kb' }))

const ALLOWED_ORIGINS = new Set([
  'http://localhost:3333',
  'http://127.0.0.1:3333',
  'http://localhost:3334',
  'http://127.0.0.1:3334',
  'http://38.49.212.111:1304',
])

app.use((req, res, next) => {
  const origin = req.headers.origin
  const requestHost = req.headers.host
  const sameOrigin = origin && requestHost && origin === `http://${requestHost}`

  if (origin && !ALLOWED_ORIGINS.has(origin) && !sameOrigin) {
    return res.status(403).json({ error: 'Forbidden origin' })
  }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  next()
})

app.options('*', (_req, res) => res.sendStatus(204))

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '')
}

function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => acc && acc[key], obj)
}

function pickDeep(obj, paths) {
  for (const path of paths) {
    const value = getByPath(obj, path)
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function asText(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (typeof value === 'object') {
    return firstDefined(value.name, value.title, value.label, value.keyword, value.text, value.value, value.url)
  }
  return String(value)
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return /^(true|yes|1)$/i.test(value)
  return !!value
}

function monthsSince(value) {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  const ms = Date.now() - date.getTime()
  return Math.max(ms / (1000 * 60 * 60 * 24 * 30.4375), 0.1)
}

function normaliseStockAsset(item) {
  const width = toNumber(pickDeep(item, ['pixelWidth', 'width', 'imageWidth', 'contentWidth', 'dimensions.width', 'details.width']))
  const height = toNumber(pickDeep(item, ['pixelHeight', 'height', 'imageHeight', 'contentHeight', 'dimensions.height', 'details.height']))
  const keywordsValue = pickDeep(item, ['keywordList', 'keywords', 'tags', 'details.keywords']) ?? []
  const keywords = Array.isArray(keywordsValue)
    ? keywordsValue.map(asText).filter(Boolean).slice(0, 40)
    : String(keywordsValue).split(',').map(k => k.trim()).filter(Boolean).slice(0, 40)
  const creator = pickDeep(item, ['creatorName', 'creator.name', 'creator', 'author.name', 'author', 'contributorName', 'contributor.name', 'user.name'])
  const title = pickDeep(item, ['assetTitle', 'title', 'name', 'caption', 'description', 'details.title'])
  const thumbnail = pickDeep(item, [
    'thumb1000Url', 'thumb500Url', 'thumbUrl', 'compUrl',
    'thumbnailUrl', 'thumbnail.url', 'thumbnail', 'previewUrl', 'preview.url', 'preview',
    'imageUrl', 'image.url', 'image', 'media.thumbnail', 'content.thumbnailUrl', 'contentUrl',
  ])
  const uploadedAt = asText(pickDeep(item, ['createdAt', 'uploadedAt', 'uploadDate', 'dateUploaded', 'publishedAt'])) ?? undefined
  const downloads = toNumber(pickDeep(item, ['downloadCount', 'downloads', 'nb_downloads', 'statistics.downloads', 'stats.downloads']))
  const explicitMonthly = toNumber(pickDeep(item, ['downloadsPerMonth', 'downloads_per_month', 'monthlyDownloads', 'statistics.downloadsPerMonth']))
  const ageMonths = monthsSince(uploadedAt)

  return {
    id: String(pickDeep(item, ['assetId', 'stockId', 'id', 'contentId', 'details.id', 'url']) ?? Math.random().toString(36).slice(2)),
    title: asText(title) ?? 'Untitled Adobe Stock asset',
    url: asText(pickDeep(item, ['detailsUrl', 'url', 'detailUrl', 'contentUrl', 'assetUrl', 'pageUrl', 'details.url'])) ?? undefined,
    creatorName: asText(creator) ?? undefined,
    creatorId: asText(pickDeep(item, ['creatorId', 'creator.id', 'contributorId', 'authorId', 'user.id'])) ?? undefined,
    countryName: asText(pickDeep(item, ['countryName', 'creator.countryName', 'country'])) ?? undefined,
    assetType: asText(pickDeep(item, ['contentType', 'assetType', 'mediaType', 'type', 'mimeType'])) ?? undefined,
    thumbnailUrl: asText(thumbnail) ?? undefined,
    width,
    height,
    downloads,
    downloadsPerMonth: explicitMonthly ?? (downloads !== undefined && ageMonths ? downloads / ageMonths : undefined),
    views: toNumber(pickDeep(item, ['viewCount', 'views', 'nb_views', 'statistics.views', 'stats.views'])),
    uploadedAt,
    isAiGenerated: toBoolean(pickDeep(item, ['isGenerativeAi', 'isAiGenerated', 'aiGenerated', 'generativeAi', 'flags.aiGenerated']) ?? false),
    keywords,
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.floor(number)))
}

function normaliseSearchBody(body) {
  const token = typeof body?.token === 'string' ? body.token.trim() : ''
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  const creatorId = typeof body?.creatorId === 'string' ? body.creatorId.trim() : String(body?.creatorId ?? '').trim()
  const maxItems = clampNumber(body?.maxItems ?? body?.limit ?? APIFY_DEFAULT_PAGE_SIZE, 1, APIFY_MAX_ITEMS, APIFY_DEFAULT_PAGE_SIZE)
  const pageSize = clampNumber(body?.pageSize ?? APIFY_DEFAULT_PAGE_SIZE, 1, APIFY_MAX_PAGE_SIZE, APIFY_DEFAULT_PAGE_SIZE)
  const assetType = typeof body?.assetType === 'string' ? body.assetType.trim() : 'all'
  const order = typeof body?.order === 'string' ? body.order.trim() : 'relevance'
  const aiFilter = typeof body?.aiFilter === 'string' ? body.aiFilter.trim() : 'all'
  const mode = body?.mode === 'portfolio' ? 'portfolio' : 'keyword'

  if (!token) return { error: 'Apify token is required.' }
  if (token.length > 500) return { error: 'Apify token is too long.' }
  if (query.length > 120) return { error: 'Search keyword is too long.' }
  if (mode === 'keyword' && !query) return { error: 'Search keyword is required.' }
  if (mode === 'portfolio' && !creatorId) return { error: 'Creator ID is required for portfolio lookup.' }

  return { token, query, creatorId, maxItems, pageSize, assetType, order, aiFilter, mode }
}

function normaliseTokenQuery(query) {
  const token = typeof query?.token === 'string' ? query.token.trim() : ''
  if (!token) return { error: 'Apify token is required.' }
  if (token.length > 500) return { error: 'Apify token is too long.' }
  return { token }
}

function normalisePageQuery(query) {
  const tokenQuery = normaliseTokenQuery(query)
  if (tokenQuery.error) return tokenQuery

  return {
    ...tokenQuery,
    limit: clampNumber(query?.limit ?? query?.pageSize ?? APIFY_DEFAULT_PAGE_SIZE, 1, APIFY_MAX_PAGE_SIZE, APIFY_DEFAULT_PAGE_SIZE),
    offset: clampNumber(query?.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 0),
  }
}

function buildAdobeStockActorInput({ query, creatorId, maxItems, assetType, order, aiFilter }) {
  const input = { maxItems, order, aiFilter }
  if (query) input.query = query
  if (creatorId) input.creatorId = Number.isFinite(Number(creatorId)) ? Number(creatorId) : creatorId
  if (assetType && assetType !== 'all') input.assetType = assetType
  return input
}

function buildApifyUrl(path, token, params = {}) {
  const url = new URL(`https://api.apify.com/v2/${path}`)
  url.searchParams.set('token', token)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

async function readApifyJson(response) {
  return response.json().catch(() => null)
}

function mapApifyError(status, fallbackDetail) {
  if (status === 401) return { httpStatus: 401, detail: 'Data provider returned 401. Check your token.' }
  if (status === 403) return { httpStatus: 403, detail: 'Data provider returned 403. Token is not allowed for this request.' }
  if (status === 404) return { httpStatus: 404, detail: 'Data provider resource was not found. The run or dataset may be unavailable.' }
  if (status === 429) return { httpStatus: 429, detail: 'Data provider rate limit reached. Wait briefly and try again.' }
  return { httpStatus: 502, detail: fallbackDetail || `Data provider returned ${status}.` }
}

function toRunStatusPayload(run) {
  const status = run?.status ?? 'UNKNOWN'
  return {
    runId: run?.id,
    status,
    datasetId: run?.defaultDatasetId,
    isTerminal: TERMINAL_RUN_STATUSES.has(status),
    isSucceeded: status === 'SUCCEEDED',
    isFailed: FAILED_RUN_STATUSES.has(status),
    startedAt: run?.startedAt,
    finishedAt: run?.finishedAt,
    statusMessage: run?.statusMessage,
  }
}

function searchMeta(search) {
  return {
    query: search.query,
    creatorId: search.creatorId,
    maxItems: search.maxItems,
    assetType: search.assetType,
    order: search.order,
    aiFilter: search.aiFilter,
    mode: search.mode,
  }
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', actor: ADOBE_STOCK_ACTOR_ID })
})

app.post('/api/apify/adobe-stock/search/start', async (req, res) => {
  const search = normaliseSearchBody(req.body)
  if (search.error) {
    return res.status(400).json({ error: search.error })
  }

  try {
    const apifyRes = await fetch(buildApifyUrl(`acts/${ADOBE_STOCK_ACTOR_ID}/runs`, search.token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildAdobeStockActorInput(search)),
    })
    const payload = await readApifyJson(apifyRes)

    if (!apifyRes.ok) {
      const { httpStatus, detail } = mapApifyError(apifyRes.status, 'Data provider failed to start the request.')
      return res.status(httpStatus).json({ error: 'Search start failed', detail })
    }

    const run = payload?.data ?? payload
    res.json({
      ...toRunStatusPayload(run),
      pageSize: search.pageSize,
      meta: searchMeta(search),
    })
  } catch (err) {
    console.error('[apify] Search start failed:', err?.message ?? err)
    res.status(500).json({ error: 'Search start failed', detail: 'Unexpected local server error while starting the data request.' })
  }
})

app.get('/api/apify/adobe-stock/runs/:runId', async (req, res) => {
  const tokenQuery = normaliseTokenQuery(req.query)
  if (tokenQuery.error) return res.status(400).json({ error: tokenQuery.error })

  try {
    const apifyRes = await fetch(buildApifyUrl(`actor-runs/${encodeURIComponent(req.params.runId)}`, tokenQuery.token))
    const payload = await readApifyJson(apifyRes)

    if (!apifyRes.ok) {
      const { httpStatus, detail } = mapApifyError(apifyRes.status, 'Data provider failed to read the job status.')
      return res.status(httpStatus).json({ error: 'Run status failed', detail })
    }

    res.json(toRunStatusPayload(payload?.data ?? payload))
  } catch (err) {
    console.error('[apify] Run status failed:', err?.message ?? err)
    res.status(500).json({ error: 'Run status failed', detail: 'Unexpected local server error while checking the data job.' })
  }
})

app.get('/api/apify/adobe-stock/datasets/:datasetId/items', async (req, res) => {
  const page = normalisePageQuery(req.query)
  if (page.error) return res.status(400).json({ error: page.error })

  try {
    const apifyRes = await fetch(buildApifyUrl(`datasets/${encodeURIComponent(req.params.datasetId)}/items`, page.token, {
      clean: true,
      format: 'json',
      limit: page.limit,
      offset: page.offset,
    }))
    const payload = await readApifyJson(apifyRes)

    if (!apifyRes.ok) {
      const { httpStatus, detail } = mapApifyError(apifyRes.status, 'Data provider failed to read dataset items.')
      return res.status(httpStatus).json({ error: 'Dataset page failed', detail })
    }

    const rawItems = Array.isArray(payload) ? payload : []
    const totalHeader = Number(apifyRes.headers.get('x-apify-pagination-total'))
    const total = Number.isFinite(totalHeader) ? totalHeader : null
    const count = rawItems.length
    const hasMore = total !== null ? page.offset + count < total : count === page.limit

    res.json({
      items: rawItems.map(normaliseStockAsset),
      rawCount: count,
      limit: page.limit,
      offset: page.offset,
      nextOffset: hasMore ? page.offset + count : null,
      hasMore,
      total,
    })
  } catch (err) {
    console.error('[apify] Dataset page failed:', err?.message ?? err)
    res.status(500).json({ error: 'Dataset page failed', detail: 'Unexpected local server error while reading the dataset.' })
  }
})

app.post('/api/apify/adobe-stock/search', async (req, res) => {
  const search = normaliseSearchBody(req.body)
  if (search.error) {
    return res.status(400).json({ error: search.error })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), APIFY_TIMEOUT_MS)

  try {
    const actorUrl = buildApifyUrl(`acts/${ADOBE_STOCK_ACTOR_ID}/run-sync-get-dataset-items`, search.token)
    const apifyRes = await fetch(actorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildAdobeStockActorInput(search)),
      signal: controller.signal,
    })

    const payload = await readApifyJson(apifyRes)

    if (!apifyRes.ok) {
      const { httpStatus, detail } = mapApifyError(apifyRes.status, 'Check the actor status or try a smaller result limit.')
      return res.status(httpStatus).json({ error: 'Search failed', detail })
    }

    const rawItems = Array.isArray(payload) ? payload : []
    const items = rawItems.map(normaliseStockAsset)

    res.json({
      items,
      rawCount: rawItems.length,
      meta: searchMeta(search),
    })
  } catch (err) {
    if (err?.name === 'AbortError') {
      return res.status(504).json({ error: 'Search timed out', detail: 'Data provider took too long to return results. Try a smaller result limit.' })
    }
    console.error('[apify] Search failed:', err?.message ?? err)
    res.status(500).json({ error: 'Search failed', detail: 'Unexpected local server error while contacting the data provider.' })
  } finally {
    clearTimeout(timeout)
  }
})

app.use(express.static(join(__dirname, '..', 'dist')))

app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, '..', 'dist', 'index.html'))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SASTOCK Research running at http://0.0.0.0:${PORT}`)
})
