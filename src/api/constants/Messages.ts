import supportsHyperlinks from 'supports-hyperlinks'
import ansiEscapes from 'ansi-escapes'
import { ColorifyConstants } from './Colors'

export const formatHyperlink = (text: string, url: string): string =>
  supportsHyperlinks.stdout
    ? `${ColorifyConstants.URL_INTERACTIVE(ansiEscapes.link(text, url))}`
    : `${text} (${ColorifyConstants.URL_INTERACTIVE(url)})`
