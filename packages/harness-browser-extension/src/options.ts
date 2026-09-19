import { getLanguage, setLanguage, t, type Language } from './i18n.js'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const heading = $('settings-heading')
const languageLabel = $('language-label')
const languageSelect = $<HTMLSelectElement>('language')

languageSelect.addEventListener('change', () => void onLanguageChange())

void initialize()

async function initialize() {
  const language = await getLanguage()
  languageSelect.value = language
  render(language)
}

async function onLanguageChange() {
  const language = languageSelect.value as Language
  await setLanguage(language)
  render(language)
}

function render(language: Language) {
  document.documentElement.lang = language
  document.title = t(language, 'settingsHeading')
  heading.textContent = t(language, 'settingsHeading')
  languageLabel.textContent = t(language, 'languageLabel')
}
