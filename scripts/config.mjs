// Everything you might want to tweak lives here.

export const FEEDS = [
  {
    // Wall Street Journal public headline feeds (Dow Jones). Full articles: Factiva via NTNU, or wsj.com.
    id: 'wsj', name: 'Wall Street Journal', short: 'WSJ', boost: 0.5,
    urls: [
      'https://feeds.content.dowjones.io/public/rss/RSSWorldNews',
      'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness',
      'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',
      'https://feeds.content.dowjones.io/public/rss/RSSWSJD',
    ],
  },
  { id: 'dn', name: 'Dagens Næringsliv', short: 'DN', boost: 0.5, urls: ['https://services.dn.no/api/feed/rss/'] },
  { id: 'nrk', name: 'NRK', short: 'NRK', boost: 0, urls: ['https://www.nrk.no/toppsaker.rss'] },
];

// Keyword topics (English + Norwegian). Matching is case-insensitive and words of
// 5+ letters also match inflections/compounds ("rente" -> "renten", "rentemøtet").
// A leading "=" means case-sensitive exact match (so "AI" doesn't hit "said").
export const TOPICS = {
  economy: {
    label: 'Economy', weight: 1,
    words: ['economy', 'economic', 'economist', 'inflation', 'gdp', 'recession', 'interest rate', 'rate cut',
      'rate hike', 'central bank', '=Fed', '=ECB', 'norges bank', 'tariff', 'trade war', 'unemployment', 'budget',
      'growth', 'økonomi', 'inflasjon', 'rente', 'styringsrente', 'sentralbank', 'arbeidsledig', 'toll',
      'statsbudsjett', 'budsjett', 'lønnsoppgjør', 'kronekurs', 'kronen', 'boligpris', 'vekst'],
  },
  finance: {
    label: 'Finance', weight: 1,
    words: ['market', 'stocks', 'shares', 'bond', 'yield', 'bank', 'investor', 'hedge fund', 'private equity',
      '=IPO', 'merger', 'acquisition', 'takeover', 'deal', 'earnings', 'profit', 'valuation', 'bitcoin', 'crypto',
      'oil price', 'wall street', 'børs', 'aksje', 'obligasjon', 'oljefond', 'investor', 'oppkjøp', 'resultat',
      'overskudd', 'milliard', 'emisjon', 'fond', 'konkurs', 'oljepris'],
  },
  ai: {
    label: 'AI', weight: 1.2,
    words: ['=AI', 'artificial intelligence', 'openai', 'anthropic', 'chatgpt', 'claude', 'gemini', 'deepmind',
      'nvidia', '=LLM', 'machine learning', 'chips', 'semiconductor', 'data centre', 'data center', 'tsmc',
      '=KI', 'kunstig intelligens', 'datasenter', 'brikke', 'robot'],
  },
  politics: {
    label: 'Politics', weight: 0.9,
    words: ['election', 'government', 'minister', 'parliament', 'congress', 'senate', 'president', 'trump',
      'white house', '=EU', '=NATO', 'sanction', 'ukraine', 'russia', 'china', 'beijing', 'xi jinping', 'iran',
      'politikk', 'valg', 'regjering', 'storting', 'statsminister', 'statsråd', 'partiet', 'sanksjon', 'kina',
      'krig'],
  },
  iphone: {
    label: 'iPhone', weight: 1.3,
    words: ['iphone', 'apple', '=iOS', 'ipad', 'tim cook', 'app store', 'macbook', 'airpods', 'vision pro'],
  },
};

// Things you probably don't want at the top.
export const NEGATIVE = ['fotball', 'football', 'sport', 'eliteserien', 'håndball', 'langrenn', 'premier league',
  'kjendis', 'celebrity', 'horoskop', 'quiz', 'oppskrift', 'recipe'];

export const LIMITS = { top: 12, topPerSource: 5, perSource: 10 };

// arXiv API queries (run one after another; arXiv asks for ~3s between requests).
export const PAPERS = {
  queries: [
    { q: '(cat:econ.GN OR cat:econ.EM OR cat:econ.TH OR cat:q-fin.GN OR cat:q-fin.ST OR cat:q-fin.TR OR cat:q-fin.CP OR cat:q-fin.PM OR cat:q-fin.RM)', max: 80 },
    { q: '(cat:cs.AI OR cat:cs.CL OR cat:cs.LG) AND (abs:economic OR abs:economy OR abs:financial OR abs:finance OR abs:market OR abs:policy)', max: 80 },
    { q: '(cat:cs.AI OR cat:cs.CL)', max: 60 },
  ],
  pick: 5,
  maxAgeDays: 7,
  words: ['large language model', '=LLM', 'agent', 'reasoning', 'transformer', 'forecast', 'monetary policy',
    'inflation', 'central bank', 'asset pricing', 'stock', 'portfolio', 'market', 'financial', 'macroeconomic',
    'labor market', 'productivity', 'trade', 'tariff', 'election', 'political', 'policy', 'regulation',
    'economic', 'firm', 'bank', 'credit', 'risk'],
};

// Used for calendar events without a time zone ("floating" times).
// Reminders lists to leave out of the To do card, e.g. ['Bøker'].
export const TODOS = { excludeLists: [] };

// placePattern: calendar events titled like this set the weather location while they last.
export const CALENDAR = {
  defaultTz: 'Asia/Shanghai', pastHours: 12, futureHours: 60,
  placePattern: /^\s*(?:📍️?|city\s*:|weather\s*:)\s*(.+)$/iu,
};
