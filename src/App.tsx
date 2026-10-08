import { useMemo, useState } from 'react'

type SearchStatus = 'idle' | 'loading' | 'success' | 'error'
type SearchMode = 'keyword' | 'portfolio'
type PageSort = 'original' | 'best' | 'downloads' | 'newest' | 'oldest'

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

interface SearchResponse {
  items: StockAsset[]
  error?: string
  detail?: string
}

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
  const [maxItems, setMaxItems] = useState(25)
  const [status, setStatus] = useState<SearchStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<StockAsset[]>([])
  const [lastSearch, setLastSearch] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  const displayedResults = useMemo(() => sortAssets(results, pageSort), [results, pageSort])
  const summary = useMemo(() => {
    const downloads = results.reduce((sum, item) => sum + (item.downloads ?? 0), 0)
    const avgMonthly = results.length ? results.reduce((sum, item) => sum + (item.downloadsPerMonth ?? 0), 0) / results.length : 0
    const ai = results.filter(item => item.isAiGenerated).length
    return { downloads, avgMonthly, ai }
  }, [results])

  const copyText = async (label: string, value: string) => {
    await navigator.clipboard?.writeText(value)
    setCopied(label)
    window.setTimeout(() => setCopied(null), 1400)
  }

  const runSearch = async (event?: React.FormEvent) => {
    event?.preventDefault()
    const cleanToken = token.trim()
    const cleanQuery = query.trim()
    const cleanCreatorId = creatorId.trim()
    const safeMax = Math.max(1, Math.min(100, Number(maxItems) || 25))

    if (!cleanToken) return setStatus('error'), setError('Masukkan Apify token dulu untuk menjalankan actor.')
    if (mode === 'keyword' && !cleanQuery) return setStatus('error'), setError('Masukkan keyword Adobe Stock yang ingin diriset.')
    if (mode === 'portfolio' && !cleanCreatorId) return setStatus('error'), setError('Masukkan creator ID untuk portfolio lookup.')

    setStatus('loading')
    setError(null)

    try {
      const apiBase = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://127.0.0.1:3334' : ''
      const response = await fetch(`${apiBase}/api/apify/adobe-stock/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: cleanToken, query: cleanQuery, creatorId: cleanCreatorId, maxItems: safeMax, assetType, order, aiFilter, mode }),
      })
      const data = await response.json().catch(() => ({})) as SearchResponse
      if (!response.ok) throw new Error(data.detail || data.error || 'Search failed. Check token atau actor Apify.')
      setResults(Array.isArray(data.items) ? data.items : [])
      setLastSearch(mode === 'portfolio' ? `Creator ${cleanCreatorId}${cleanQuery ? ` / ${cleanQuery}` : ''}` : cleanQuery)
      setPageSort('original')
      setStatus('success')
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Search failed. Please try again.')
    }
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
          <div className="token-line"><label><span>Apify token</span><input type={showToken ? 'text' : 'password'} value={token} onChange={e => setToken(e.target.value)} placeholder="apify_api_..." autoComplete="off" /></label><button type="button" onClick={() => setShowToken(value => !value)}>{showToken ? 'Hide' : 'Show'}</button></div>
          <div className="query-line">
            {mode === 'portfolio' && <label><span>Creator ID</span><input value={creatorId} onChange={e => setCreatorId(e.target.value)} placeholder="212402067" /></label>}
            <label className="query-field"><span>{mode === 'portfolio' ? 'Keyword in portfolio (optional)' : 'Search keyword'}</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="business meeting" /></label>
            <label><span>Content type</span><select value={assetType} onChange={e => setAssetType(e.target.value)}>{assetTypes.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
            <label><span>Adobe sort</span><select value={order} onChange={e => setOrder(e.target.value)}>{adobeOrders.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label><span>AI content</span><select value={aiFilter} onChange={e => setAiFilter(e.target.value)}>{aiFilters.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label className="limit-field"><span>Limit</span><input type="number" min={1} max={100} value={maxItems} onChange={e => setMaxItems(Number(e.target.value))} /></label>
            <button className="primary-button" disabled={status === 'loading'}>{status === 'loading' ? 'Searching…' : 'Search'}</button>
          </div>
          {mode === 'keyword' && <div className="chip-row">{suggestedSearches.map(item => <button type="button" key={item} onClick={() => setQuery(item)}>{item}</button>)}</div>}
          <p className="privacy-note">Token hanya dikirim ke backend lokal untuk request Apify dan tidak disimpan.</p>
        </form>
      </section>

      {error && <div className="error-box">{error}</div>}
      {copied && <div className="copy-toast">Copied {copied}</div>}

      <section className="metrics-row"><div><span>Loaded assets</span><strong>{results.length}</strong></div><div><span>Total downloads</span><strong>{formatMetric(summary.downloads)}</strong></div><div><span>Avg downloads / month</span><strong>{formatMetric(summary.avgMonthly)}</strong></div><div><span>AI generated</span><strong>{summary.ai}</strong></div></section>

      <section className="results-section" id="results">
        <div className="section-title"><div><span className="eyebrow">Asset results</span><h2>{lastSearch ? <>Results for <em>{lastSearch}</em></> : 'Start a search to load assets'}</h2></div><div className="result-tools"><label><span>Sort this page</span><select value={pageSort} onChange={e => setPageSort(e.target.value as PageSort)}>{pageSorts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><span className="result-count">{results.length} items</span></div></div>
        {status === 'idle' && <div className="empty-state">🔎 Masukkan token dan keyword, lalu klik Search.</div>}
        {status === 'loading' && <div className="empty-state">⏳ Menjalankan Apify actor dan mengambil dataset…</div>}
        {status === 'success' && results.length === 0 && <div className="empty-state">📭 Tidak ada hasil. Coba keyword lain.</div>}

        {displayedResults.length > 0 && <div className="asset-grid">{displayedResults.map((asset, index) => {
          const keywordText = asset.keywords?.join(', ') ?? ''
          return <article className="asset-card" key={`${asset.id}-${index}`}><div className="asset-image"><span className="rank">#{index + 1}</span>{asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" /> : <div className="no-image">No image</div>}{asset.url && <a className="open-link" href={asset.url} target="_blank" rel="noreferrer">↗</a>}</div><div className="asset-body"><div className="asset-title-row"><h3>{asset.title}</h3><button type="button" onClick={() => copyText('title', asset.title)}>Copy</button></div><p className="asset-id">ID: {asset.id}</p><p className="creator-line">{asset.assetType || 'asset'} • By {asset.creatorName || 'Unknown creator'}{asset.creatorId ? ` (${asset.creatorId})` : ''}</p><div className="badges"><span>{asset.assetType || 'asset'}</span>{asset.isAiGenerated && <span>AI generated</span>}</div><div className="performance"><div><small>Downloads</small><strong>{formatMetric(asset.downloads)}</strong></div><div><small>Downloads / month</small><strong>{formatMetric(asset.downloadsPerMonth)}</strong></div></div><div className="upload-row"><span>Uploaded</span><strong>{formatDate(asset.uploadedAt)}</strong><span>{timeAgo(asset.uploadedAt)}</span></div>{!!asset.keywords?.length && <div className="keywords">{asset.keywords.slice(0, 5).map(keyword => <span key={keyword}>{keyword}</span>)}{asset.keywords.length > 5 && <span>+{asset.keywords.length - 5}</span>}</div>}<div className="card-actions"><button type="button" onClick={() => copyText('keywords', keywordText)} disabled={!keywordText}>Copy Keywords</button>{asset.url && <a href={asset.url} target="_blank" rel="noreferrer">Analyze Asset</a>}</div></div></article>
        })}</div>}
      </section>
    </main>
  )
}

export default App
