/* Permission keys mirrored from backend/auth.py. */

// One per document-set tab on the Unstructured Explorer (auth.py UNSTRUCTURED_TABS)
export const UNSTRUCTURED_TABS = {
  vr: 'viewUnstructuredVR',
  immbot: 'viewUnstructuredIMMBOT',
  mirai: 'viewUnstructuredMirAI',
  rmwcreate: 'viewUnstructuredRMWCreate',
  haq: 'viewUnstructuredHAQ',
  nipo: 'viewUnstructuredNipo',
  rimdocs: 'viewUnstructuredRimDocs',
  rimingest: 'viewUnstructuredRimIngestion',
  epod: 'viewUnstructuredEPOD',
  fda: 'viewUnstructuredFDA',
};
// Sub-tabs inside each document set (auth.py UNSTRUCTURED_SUBTABS), by doc id then sub-tab id
export const UNSTRUCTURED_SUBTABS = {
  vr: { internal: 'viewUnstructuredVRInternal', external: 'viewUnstructuredVRExternal', cortellis: 'viewUnstructuredVRCortellis' },
  immbot: { explore: 'viewUnstructuredIMMBOTExplore', table: 'viewUnstructuredIMMBOTTable', breakdown: 'viewUnstructuredIMMBOTBreakdown' },
  rimdocs: { overview: 'viewUnstructuredRimDocsExplore', table: 'viewUnstructuredRimDocsTable', breakdown: 'viewUnstructuredRimDocsBreakdown' },
  rimingest: { overview: 'viewUnstructuredRimIngestionOverview', breakdown: 'viewUnstructuredRimIngestionBreakdown', documents: 'viewUnstructuredRimIngestionDocuments' },
  epod: { explore: 'viewUnstructuredEPODExplore', table: 'viewUnstructuredEPODTable' },
  nipo: { explore: 'viewUnstructuredNipoExplore', table: 'viewUnstructuredNipoTable' },
  fda: { explore: 'viewUnstructuredFDAExplore', table: 'viewUnstructuredFDATable' },
};
