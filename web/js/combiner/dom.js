/**
 * GooseQuill — Combiner Element Lookups
 *
 * Every element the Combiner owns, named once. These were repeated
 * getElementById calls scattered through a 1,089-line file, several of them
 * fetched three or four times in different functions under slightly different
 * variable names.
 */

export const byId = (id) => document.getElementById(id);

/* Source list */
export const fileList = () => byId("studioCombinerFileList");
export const searchInput = () => byId("studioCombinerSearchInput");
export const sourceFolderSelect = () => byId("studioCombinerSourceFolderSelect");
export const sourceSummary = () => byId("studioCombinerSourceSummary");
export const selectedBadge = () => byId("studioCombinerSelectedCountBadge");
export const folderNotice = () => byId("studioCombinerFolderNotice");
export const includeConsolidated = () => byId("studioCombinerIncludeConsolidated");

/* Output settings */
export const masterTitleInput = () => byId("studioCombinerMasterTitleInput");
export const outputFilenameInput = () => byId("studioCombinerOutputFilenameInput");
export const targetFolderSelect = () => byId("studioCombinerTargetFolderSelect");
export const saveDestinationText = () => byId("studioCombinerSaveDestinationText");
export const includeToc = () => byId("studioCombinerIncludeToc");
export const includeSourceMeta = () => byId("studioCombinerIncludeSourceMeta");
export const stripHeaders = () => byId("studioCombinerStripHeaders");

/* Preview */
export const previewNotice = () => byId("studioCombinerPreviewNotice");
export const renderedPane = () => byId("studioCombinerTabRendered");
export const renderedContent = () => byId("studioCombinerRenderedContent");
export const rawTextarea = () => byId("studioCombinerRawMarkdownTextarea");
export const rawPane = () => byId("studioCombinerTabRaw");
export const previewTabs = () => document.querySelectorAll("#studioCombinerPreviewTabs .tab-btn");

/* Stats */
export const statDocs = () => byId("studioCombinerStatDocs");
export const statPages = () => byId("studioCombinerStatPages");
export const statWords = () => byId("studioCombinerStatWords");
export const statChars = () => byId("studioCombinerStatChars");

/* Actions */
export const copyBtn = () => byId("studioCombinerCopyBtn");
export const downloadBtn = () => byId("studioCombinerDownloadBtn");
export const saveBtn = () => byId("studioCombinerSaveBtn");
