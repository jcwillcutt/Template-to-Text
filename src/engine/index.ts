// Public surface of the template engine: exactly what the UI imports.
export * from './templates-catalog';
export { formatDateTime } from './datetime';
export { stripComments, templateNeedsSelectionObjects, IDENTIFIER_REGEX } from './lexicon';
export { mediaTypeForExtension, buildZipBase64, type ZipEntry } from './zip';
export { planOutputFiles, buildOutputFiles, yieldToBrowser, type FilePlan, type OutputFiles } from './plan';
