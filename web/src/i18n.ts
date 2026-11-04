import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import english from './locales/en'

export const languageKey = 'cdk-language'
export function detectLanguage(saved: string | null, languages: readonly string[]): 'zh-CN' | 'en' {
  if (saved === 'zh-CN' || saved === 'en') return saved
  return languages[0]?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

let saved: string | null = null
try { saved = localStorage.getItem(languageKey) } catch { /* Storage may be disabled. */ }

void i18n.use(initReactI18next).init({
  lng: detectLanguage(saved, navigator.languages || [navigator.language]),
  fallbackLng: 'en',
  supportedLngs: ['zh-CN', 'en'],
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  resources: {
    en: { translation: english },
    'zh-CN': { translation: Object.fromEntries(Object.keys(english).map((key) => [key, key])) },
  },
})

function syncDocument(language: string) {
  document.documentElement.lang = language
  document.title = language === 'zh-CN' ? 'CDK · 兑换中心' : 'CDK · Redemption Center'
}
syncDocument(i18n.language)
i18n.on('languageChanged', (language) => {
  syncDocument(language)
  try { localStorage.setItem(languageKey, language) } catch { /* Language still changes in memory. */ }
})

export const t = i18n.t.bind(i18n)
export const locale = () => i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US'
export default i18n
