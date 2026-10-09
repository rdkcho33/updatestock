import { useEffect, useMemo, useState } from 'react'

type SearchStatus = 'idle' | 'starting' | 'polling' | 'loadingPage' | 'success' | 'error'
type SearchMode = 'keyword' | 'portfolio'
type PageSort = 'original' | 'best' | 'downloads' | 'newest' | 'oldest'
type ResultsView = 'results' | 'favorites'

interface StockAsset {
  id: string
  title: string
  url?: string
  creatorName?: string
  creatorId?: string
  countryName?: string
  assetType?: string
  thumbnailUrl?: string
  width?: number
  height?: number
  downloads?: number
  downloadsPerMonth?: number
  views?: number
  uploadedAt?: string
  isAiGenerated?: boolean
  keywords?: string[]
}

interface ApiErrorResponse {
  error?: string
  detail?: string
}

interface StartSearchResponse extends ApiErrorResponse {
  runId?: string
  status?: string
  datasetId?: string
  pageSize?: number
}

interface RunStatusResponse extends ApiErrorResponse {
  runId?: string
  status?: string
  datasetId?: string
  isTerminal?: boolean
  isSucceeded?: boolean
  isFailed?: boolean
  statusMessage?: string
}

interface DatasetPageResponse extends ApiErrorResponse {
  items?: StockAsset[]
  rawCount?: number
  limit?: number
  offset?: number
  nextOffset?: number | null
  hasMore?: boolean
  total?: number | null
}

const FAVORITES_STORAGE_KEY = 'sastock:favorites:v1'
const suggestedSearches = ['business', 'work', 'ai chatbot', 'family house', 'contract signing', 'doctor office']
const assetTypes = [
  { value: 'all', label: 'All' },
  { value: 'photo', label: 'Photo' },
  { value: 'video', label: 'Video' },
  { value: 'vector', label: 'Vector' },
  { value: 'illustration', label: 'Illustration' },
]
const adobeOrders = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'featured', label: 'Featured' },
  { value: 'downloads', label: 'Most downloaded' },
  { value: 'newest', label: 'Newest' },
  { value: 'undiscovered', label: 'Undiscovered' },
]
const aiFilters = [
  { value: 'all', label: 'All content' },
  { value: 'only', label: 'AI generated' },
  { value: 'exclude', label: 'Exclude AI' },
]
const pageSorts: { value: PageSort; label: string }[] = [
  { value: 'original', label: 'Original' },
  { value: 'best', label: 'Best performance' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
]

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))
const isLocalhost = () => window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
const apiBase = () => isLocalhost() ? 'http://127.0.0.1:3334' : ''

function assetFavoriteKey(asset: StockAsset) {
  return asset.id || asset.url || `${asset.title}-${asset.creatorId || asset.creatorName || ''}`
}

function readFavoritesFromStorage() {
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(item => item?.title) as StockAsset[] : []
  } catch {
    return []
  }
}

function writeFavoritesToStorage(items: StockAsset[]) {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(items))
  } catch {
    // localStorage can be disabled in privacy mode; keep in-memory favorites working.
  }
}

async function writeClipboardText(value: string) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  const successful = document.execCommand('copy')
  document.body.removeChild(textarea)

  if (!successful) throw new Error('Clipboard copy is blocked by this browser. Use HTTPS or copy manually.')
}

function formatMetric(value?: number) {
  if (typeof value !== 'number') return '—'
  return new Intl.NumberFormat('en', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

function formatDate(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  return date.toISOString().slice(0, 10)
}

function timeAgo(value?: string) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const days = Math.max(1, Math.round((Date.now() - date.getTime()) / 86_400_000))
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

function sortAssets(items: StockAsset[], sort: PageSort) {
  return [...items].sort((a, b) => {
    if (sort === 'best') return (b.downloadsPerMonth ?? -1) - (a.downloadsPerMonth ?? -1)
    if (sort === 'downloads') return (b.downloads ?? -1) - (a.downloads ?? -1)
    if (sort === 'newest') return new Date(b.uploadedAt ?? 0).getTime() - new Date(a.uploadedAt ?? 0).getTime()
    if (sort === 'oldest') return new Date(a.uploadedAt ?? 0).getTime() - new Date(b.uploadedAt ?? 0).getTime()
    return 0
  })
}

function formatFavoriteTitles(items: StockAsset[]) {
  return items.map(item => item.title).filter(Boolean).join('\n')
}

function formatFavoriteKeywords(items: StockAsset[]) {
  const keywords = new Set<string>()
  items.forEach(item => item.keywords?.forEach(keyword => {
    const clean = keyword.trim()
    if (clean) keywords.add(clean)
  }))
  return Array.from(keywords).join(', ')
}

function formatFavoriteTitlesAndKeywords(items: StockAsset[]) {
  return items.map(item => `${item.title}\n${item.keywords?.join(', ') || 'No keywords'}`).join('\n\n')
}

function App() {
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [mode, setMode] = useState<SearchMode>('keyword')
  const [query, setQuery] = useState('work')
  const [creatorId, setCreatorId] = useState('')
  const [assetType, setAssetType] = useState('all')
  const [order, setOrder] = useState('relevance')
  const [aiFilter, setAiFilter] = useState('all')
  const [pageSort, setPageSort] = useState<PageSort>('original')
  const [maxItems, setMaxItems] = useState(100)
  const [pageSize, setPageSize] = useState(25)
  const [status, setStatus] = useState<SearchStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<StockAsset[]>([])
  const [lastSearch, setLastSearch] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [datasetId, setDatasetId] = useState<string | null>(null)
  const [activeToken, setActiveToken] = useState('')
  const [offset, setOffset] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState<number | null>(null)
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const [pageHistory, setPageHistory] = useState<number[]>([])
  const [favorites, setFavorites] = useState<StockAsset[]>(() => readFavoritesFromStorage())
  const [resultsView, setResultsView] = useState<ResultsView>('results')

  useEffect(() => {
    writeFavoritesToStorage(favorites)
  }, [favorites])

  const displayedResults = useMemo(() => sortAssets(results, pageSort), [results, pageSort])
  const favoriteKeys = useMemo(() => new Set(favorites.map(assetFavoriteKey)), [favorites])
  const visibleAssets = resultsView === 'favorites' ? favorites : displayedResults
  const summary = useMemo(() => {
    const source = resultsView === 'favorites' ? favorites : results
    const downloads = source.reduce((sum, item) => sum + (item.downloads ?? 0), 0)
    const avgMonthly = source.length ? source.reduce((sum, item) => sum + (item.downloadsPerMonth ?? 0), 0) / source.length : 0
    const ai = source.filter(item => item.isAiGenerated).length
    return { downloads, avgMonthly, ai }
  }, [favorites, results, resultsView])
  const isBusy = status === 'starting' || status === 'polling' || status === 'loadingPage'
  const pageEnd = offset + results.length
  const pageRange = results.length ? `Showing ${offset + 1}–${pageEnd}${total !== null ? ` of ${total}` : ''}` : `${results.length} items`
  const loadingMessage = status === 'starting'
    ? '🚀 Menjalankan proses data…'
    : status === 'polling'
      ? `⏳ Menunggu proses data selesai${runStatus ? ` (${runStatus})` : ''}…`
      : '📄 Mengambil halaman data…'

  const copyText = async (label: string, value: string) => {
    if (!value.trim()) {
      setError('Tidak ada teks untuk disalin.')
      return
    }
    try {
      await writeClipboardText(value)
      setCopied(label)
      setError(null)
      window.setTimeout(() => setCopied(null), 1400)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Copy gagal. Gunakan HTTPS atau salin manual.')
    }
  }

  const isFavorite = (asset: StockAsset) => favoriteKeys.has(assetFavoriteKey(asset))

  const toggleFavorite = (asset: StockAsset) => {
    const key = assetFavoriteKey(asset)
    setFavorites(current => current.some(item => assetFavoriteKey(item) === key)
      ? current.filter(item => assetFavoriteKey(item) !== key)
      : [{ ...asset }, ...current])
  }

  const clearFavorites = () => {
    setFavorites([])
    setCopied('favorites cleared')
    window.setTimeout(() => setCopied(null), 1400)
  }

  const copyFavoriteTitles = () => copyText('all titles', formatFavoriteTitles(favorites))
  const copyFavoriteKeywords = () => copyText('all keywords', formatFavoriteKeywords(favorites))
  const copyFavoriteTitlesAndKeywords = () => copyText('titles + keywords', formatFavoriteTitlesAndKeywords(favorites))

  const loadDatasetPage = async (currentDatasetId: string, currentToken: string, limit: number, pageOffset: number) => {
    setStatus('loadingPage')
    setError(null)

    const params = new URLSearchParams({ token: currentToken, limit: String(limit), offset: String(pageOffset) })
    const response = await fetch(`${apiBase()}/api/apify/adobe-stock/datasets/${encodeURIComponent(currentDatasetId)}/items?${params}`)
    const data = await response.json().catch(() => ({})) as DatasetPageResponse
    if (!response.ok) throw new Error(data.detail || data.error || 'Failed to load data page.')

    setResults(Array.isArray(data.items) ? data.items : [])
    setOffset(typeof data.offset === 'number' ? data.offset : pageOffset)
    setNextOffset(typeof data.nextOffset === 'number' ? data.nextOffset : null)
    setHasMore(Boolean(data.hasMore))
    setTotal(typeof data.total === 'number' ? data.total : null)
    setPageSort('original')
    setResultsView('results')
    setStatus('success')
  }

  const pollRun = async (currentRunId: string, currentToken: string) => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 180_000) {
      const params = new URLSearchParams({ token: currentToken })
      const response = await fetch(`${apiBase()}/api/apify/adobe-stock/runs/${encodeURIComponent(currentRunId)}?${params}`)
      const data = await response.json().catch(() => ({})) as RunStatusResponse
      if (!response.ok) throw new Error(data.detail || data.error || 'Failed to check data job status.')

      setRunStatus(data.status ?? null)
      if (data.datasetId) setDatasetId(data.datasetId)
      if (data.isSucceeded) return data
      if (data.isFailed) throw new Error(data.statusMessage || `Data job ended with status ${data.status}.`)
      await sleep(2000)
    }
    throw new Error('Proses data masih berjalan lebih dari 3 menit. Coba search ulang atau turunkan Max scrape.')
  }

  const runSearch = async (event?: React.FormEvent) => {
    event?.preventDefault()
    const cleanToken = token.trim()
    const cleanQuery = query.trim()
    const cleanCreatorId = creatorId.trim()
    const safeMax = Math.max(1, Math.min(1000, Number(maxItems) || 100))
    const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 25))

    if (!cleanToken) return setStatus('error'), setError('Masukkan API token dulu untuk menjalankan pencarian.')
    if (mode === 'keyword' && !cleanQuery) return setStatus('error'), setError('Masukkan keyword Adobe Stock yang ingin diriset.')
    if (mode === 'portfolio' && !cleanCreatorId) return setStatus('error'), setError('Masukkan creator ID untuk portfolio lookup.')

    setStatus('starting')
    setError(null)
    setResults([])
    setRunId(null)
    setDatasetId(null)
    setActiveToken(cleanToken)
    setOffset(0)
    setNextOffset(null)
    setHasMore(false)
    setTotal(null)
    setRunStatus(null)
    setPageHistory([])
    setResultsView('results')

    try {
      const response = await fetch(`${apiBase()}/api/apify/adobe-stock/search/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cleanToken, query: cleanQuery, creatorId: cleanCreatorId, maxItems: safeMax, pageSize: safePageSize, assetType, order, aiFilter, mode }),
      })
      const data = await response.json().catch(() => ({})) as StartSearchResponse
      if (!response.ok) throw new Error(data.detail || data.error || 'Search failed. Check token atau konfigurasi data provider.')
      if (!data.runId) throw new Error('Data provider tidak mengembalikan job ID.')

      setRunId(data.runId)
      setRunStatus(data.status ?? null)
      if (data.datasetId) setDatasetId(data.datasetId)
      setLastSearch(mode === 'portfolio' ? `Creator ${cleanCreatorId}${cleanQuery ? ` / ${cleanQuery}` : ''}` : cleanQuery)
      setStatus('polling')

      const completed = await pollRun(data.runId, cleanToken)
      const completedDatasetId = completed.datasetId || data.datasetId
      if (!completedDatasetId) throw new Error('Proses data selesai tapi dataset ID tidak tersedia.')

      setDatasetId(completedDatasetId)
      await loadDatasetPage(completedDatasetId, cleanToken, safePageSize, 0)
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Search failed. Please try again.')
    }
  }

  const loadNextPage = async () => {
    if (!datasetId || nextOffset === null || isBusy) return
    const currentOffset = offset
    try {
      setPageHistory(history => [...history, currentOffset])
      await loadDatasetPage(datasetId, activeToken, pageSize, nextOffset)
    } catch (err) {
      setPageHistory(history => history.slice(0, -1))
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Failed to load next page.')
    }
  }

  const loadPreviousPage = async () => {
    if (!datasetId || !pageHistory.length || isBusy) return
    const previousOffset = pageHistory[pageHistory.length - 1]
    try {
      setPageHistory(history => history.slice(0, -1))
      await loadDatasetPage(datasetId, activeToken, pageSize, previousOffset)
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Failed to load previous page.')
    }
  }

  const renderAssetCard = (asset: StockAsset, index: number) => {
    const keywordText = asset.keywords?.join(', ') ?? ''
    const favorite = isFavorite(asset)
    const rank = resultsView === 'favorites' ? index + 1 : offset + index + 1

    return <article className={`asset-card${favorite ? ' is-favorite' : ''}`} key={`${assetFavoriteKey(asset)}-${resultsView}-${index}`}><div className="asset-image"><span className="rank">#{rank}</span>{asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" /> : <div className="no-image">No image</div>}{asset.url && <a className="open-link" href={asset.url} target="_blank" rel="noreferrer">↗</a>}</div><div className="asset-body"><div className="asset-title-row"><h3>{asset.title}</h3><button type="button" onClick={() => copyText('title', asset.title)}>Copy</button><button type="button" className={`favorite-button${favorite ? ' active' : ''}`} onClick={() => toggleFavorite(asset)}>{favorite ? '♥ Saved' : '♡ Favorite'}</button></div><p className="asset-id">ID: {asset.id}</p><p className="creator-line">{asset.assetType || 'asset'} • By {asset.creatorName || 'Unknown creator'}{asset.creatorId ? ` (${asset.creatorId})` : ''}</p><div className="badges"><span>{asset.assetType || 'asset'}</span>{asset.isAiGenerated && <span>AI generated</span>}</div><div className="performance"><div><small>Downloads</small><strong>{formatMetric(asset.downloads)}</strong></div><div><small>Downloads / month</small><strong>{formatMetric(asset.downloadsPerMonth)}</strong></div></div><div className="upload-row"><span>Uploaded</span><strong>{formatDate(asset.uploadedAt)}</strong><span>{timeAgo(asset.uploadedAt)}</span></div>{!!asset.keywords?.length && <div className="keywords">{asset.keywords.slice(0, 5).map(keyword => <span key={keyword}>{keyword}</span>)}{asset.keywords.length > 5 && <span>+{asset.keywords.length - 5}</span>}</div>}<div className="card-actions"><button type="button" onClick={() => copyText('keywords', keywordText)} disabled={!keywordText}>Copy Keywords</button>{asset.url && <a href={asset.url} target="_blank" rel="noreferrer">Analyze Asset</a>}</div></div></article>
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <div className="brand"><div className="brand-mark">SA</div><div><strong>SASTOCK Research</strong><span>Adobe Stock Search Intelligence</span></div></div>
        <nav><button className={mode === 'keyword' ? 'active' : ''} onClick={() => setMode('keyword')}>Keyword Search</button><button className={mode === 'portfolio' ? 'active' : ''} onClick={() => setMode('portfolio')}>Portfolio Lookup</button></nav>
      </header>

      <section className="search-hero" id="search">
        <div className="hero-copy"><span className="eyebrow">Adobe Stock Research</span><h1>Find assets, downloads, and creator signals in one dashboard.</h1><p>Keyword Search untuk riset pasar. Portfolio Lookup untuk cek performa aset kreator tertentu memakai creator ID Adobe Stock.</p></div>
        <form className="search-card" onSubmit={runSearch}>
          <div className="tab-switch"><button type="button" className={mode === 'keyword' ? 'active' : ''} onClick={() => setMode('keyword')}>Keyword Search</button><button type="button" className={mode === 'portfolio' ? 'active' : ''} onClick={() => setMode('portfolio')}>Portfolio Lookup</button></div>
          <div className="token-line"><label><span>API token</span><input type={showToken ? 'text' : 'password'} value={token} onChange={e => setToken(e.target.value)} placeholder="api token" autoComplete="off" /></label><button type="button" onClick={() => setShowToken(value => !value)}>{showToken ? 'Hide' : 'Show'}</button></div>
          <div className="query-line">
            {mode === 'portfolio' && <label><span>Creator ID</span><input value={creatorId} onChange={e => setCreatorId(e.target.value)} placeholder="212402067" /></label>}
            <label className="query-field"><span>{mode === 'portfolio' ? 'Keyword in portfolio (optional)' : 'Search keyword'}</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="business meeting" /></label>
            <label><span>Content type</span><select value={assetType} onChange={e => setAssetType(e.target.value)}>{assetTypes.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
            <label><span>Adobe sort</span><select value={order} onChange={e => setOrder(e.target.value)}>{adobeOrders.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label><span>AI content</span><select value={aiFilter} onChange={e => setAiFilter(e.target.value)}>{aiFilters.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label className="limit-field"><span>Max scrape</span><input type="number" min={1} max={1000} value={maxItems} onChange={e => setMaxItems(Number(e.target.value))} /></label>
            <label className="limit-field"><span>Page size</span><input type="number" min={1} max={100} value={pageSize} onChange={e => setPageSize(Number(e.target.value))} /></label>
            <button className="primary-button" disabled={isBusy}>{isBusy ? 'Working…' : 'Search'}</button>
          </div>
          {mode === 'keyword' && <div className="chip-row">{suggestedSearches.map(item => <button type="button" key={item} onClick={() => setQuery(item)}>{item}</button>)}</div>}
          <p className="privacy-note">Token hanya dikirim ke backend lokal untuk request data dan tidak disimpan.</p>
        </form>
      </section>

      {error && <div className="error-box">{error}</div>}
      {copied && <div className="copy-toast">Copied {copied}</div>}

      <section className="metrics-row"><div><span>{resultsView === 'favorites' ? 'Favorite assets' : 'Page assets'}</span><strong>{visibleAssets.length}</strong></div><div><span>{resultsView === 'favorites' ? 'Favorite downloads' : 'Page downloads'}</span><strong>{formatMetric(summary.downloads)}</strong></div><div><span>Avg downloads / month</span><strong>{formatMetric(summary.avgMonthly)}</strong></div><div><span>AI generated</span><strong>{summary.ai}</strong></div></section>

      <section className="results-section" id="results">
        <div className="section-title"><div><span className="eyebrow">Asset results</span><h2>{lastSearch ? <>Results for <em>{lastSearch}</em></> : 'Start a search to load assets'}</h2>{runId && <p className="run-note">Job {runId.slice(0, 8)}{runStatus ? ` · ${runStatus}` : ''}</p>}</div><div className="result-tools"><div className="view-switch"><button type="button" className={resultsView === 'results' ? 'active' : ''} onClick={() => setResultsView('results')}>Results</button><button type="button" className={resultsView === 'favorites' ? 'active' : ''} onClick={() => setResultsView('favorites')}>Favorites ({favorites.length})</button></div><label><span>Sort this page</span><select value={pageSort} onChange={e => setPageSort(e.target.value as PageSort)} disabled={resultsView === 'favorites'}>{pageSorts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><span className="result-count">{resultsView === 'favorites' ? `${favorites.length} favorites` : pageRange}</span>{resultsView === 'results' && <div className="pagination-controls"><button type="button" disabled={!pageHistory.length || isBusy} onClick={loadPreviousPage}>Previous</button><button type="button" disabled={!hasMore || !datasetId || isBusy} onClick={loadNextPage}>Next</button></div>}<div className="bulk-actions"><button type="button" disabled={!favorites.length} onClick={copyFavoriteTitles}>Copy all titles</button><button type="button" disabled={!favorites.length} onClick={copyFavoriteKeywords}>Copy all keywords</button><button type="button" disabled={!favorites.length} onClick={copyFavoriteTitlesAndKeywords}>Copy titles + keywords</button><button type="button" disabled={!favorites.length} onClick={clearFavorites}>Clear favorites</button></div></div></div>
        {status === 'idle' && resultsView === 'results' && <div className="empty-state">🔎 Masukkan token dan keyword, lalu klik Search.</div>}
        {isBusy && resultsView === 'results' && <div className="empty-state">{loadingMessage}</div>}
        {status === 'success' && resultsView === 'results' && results.length === 0 && <div className="empty-state">📭 Tidak ada hasil. Coba keyword lain.</div>}
        {resultsView === 'favorites' && favorites.length === 0 && <div className="empty-state">⭐ Belum ada favorite. Klik Favorite pada asset yang ingin disimpan.</div>}

        {visibleAssets.length > 0 && <div className="asset-grid">{visibleAssets.map(renderAssetCard)}</div>}
      </section>
    </main>
  )
}

export default App
