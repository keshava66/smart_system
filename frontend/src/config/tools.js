import dqIcon            from "/icons/JJ_Icon_Analysis_RGB.svg";
import searchIcon        from "/icons/JJ_Icon_Search_RGB.svg";
import aiIcon            from "/icons/JJ_Icon_AI_RGB.svg";
import gearIcon          from "/icons/JJ_Icon_Gear_RGB.svg";
import commsIcon         from "/icons/JJ_Icon_Communication_RGB.svg";
import validationIcon    from "/icons/JJ_Icon_Records_Information_RGB.svg";
import unstructuredIcon  from "/icons/JJ_Icon_Data_Visualization.svg";
import infographicIcon   from "/icons/JJ_Icon_Presentation_RGB.svg";
import dataStudioIcon    from "/icons/JJ_Icon_Database_RGB.svg";
import dataApiIcon       from "/icons/JJ_Icon_Network_RGB.svg";
import auditIcon         from "/icons/JJ_Icon_Stationery_RGB.svg";
import pipelineIcon      from "/icons/JJ_Icon_Link_RGB.svg";
import evidenceFlowIcon  from "/icons/JJ_Icon_AI_RGB.svg";

export const TOOL_CATALOG = [
  {
    id: 'dqe',
    title: 'Data Quality Engine',
    description: 'Monitor and validate data migration with real-time quality checks, comprehensive validation reports, and detailed analytics.',
    icon: dqIcon, badge: 'NEW', path: '/dqe',
    permission: 'viewDQE', colorKey: 'red', category: 'Data',
    sections: [
      { label: 'IT Checks',               path: '/dqe?check=IT_Checks',               permission: 'viewITChecks' },
      { label: 'Data Validation',         path: '/dqe?check=Data_Validation',         permission: 'viewDataValidation' },
      { label: 'Business Defined Checks', path: '/dqe?check=Business_defined_checks', permission: 'viewBusinessChecks' },
      { label: 'IND/CTA Data Quality',        path: '/dqe?check=IND_CTA_DQ',                  permission: 'viewIndCtaQuality' },
      { label: 'Safety',                  path: '/dqe?check=Safety_DQ',               permission: 'viewSafetyDQ' },
    ],
    // Ordered: each param contributes one step to the breadcrumb, so
    // ?check=Business_defined_checks&tab=failed-rows reads
    // "Business Defined Checks › Failed rows".
    trail: [
      ['check', {
        IT_Checks: 'IT Checks',
        Data_Validation: 'Data Validation',
        Business_defined_checks: 'Business Defined Checks',
        IND_CTA_DQ: 'IND/CTA Data Quality',
        Safety_DQ: 'Safety',
      }],
      ['tab', {
        overview: 'Overview',
        'dataset-health': 'Dataset health',
        trends: 'Trends',
        'failed-rows': 'Failed rows',
        admin: 'Admin',
        review: 'Review',
      }],
      ['indctatab', { issues: 'Issue explorer' }],
    ],
  },
  {
    id: 'rag',
    title: 'RAG (Retrieval-Augmented Generation)',
    description: 'Retrieve and generate answers from various document repositories using AI-powered retrieval-augmented generation.',
    icon: aiIcon, badge: null, path: '/rag',
    permission: 'viewRAG', colorKey: 'blue', category: 'AI',
    sections: [
      { label: 'RIMDocs Agentic', path: '/rag?tab=rimdocs-agentic', permission: 'viewRimDocsAgentic' },
      { label: 'RAG Evaluation',  path: '/rag/evaluation',          permission: 'viewRimDocsAgentic' },
      { label: 'Rimdocs Legacy Agentic RAG', path: '/rag?tab=rimdocs',         permission: 'viewRimDocsRAG' },
      { label: 'EPOD',            path: '/rag?tab=epod',            permission: 'viewEPodRAG' },
    ],
    trail: [
      ['tab', { epod: 'EPOD', rimdocs: 'Rimdocs Legacy Agentic RAG', 'rimdocs-agentic': 'RIMDocs Agentic' }],
    ],
  },
  {
    id: 'fuzzy-match',
    title: 'Fuzzy Match',
    description: 'Search every Denodo view for a word or value, with typo tolerance, metadata search and Excel export.',
    icon: searchIcon, badge: null, path: '/fuzzy-match',
    permission: 'viewFuzzyMatch', colorKey: 'dgray', category: 'Data',
  },
  {
    id: 'evidenceflow',
    title: 'EvidenceFlow',
    description: 'Review original PBRER and DSUR PDFs, extract evidence linked to the source page, and export it for review.',
    icon: evidenceFlowIcon, badge: 'NEW', path: '/evidenceflow',
    permission: 'viewEvidenceFlow', colorKey: 'gray', category: 'Data',
  },
  {
    id: 'ai-chatbot',
    title: 'AI Assistant',
    description: 'Ask questions about your data, generate insights, and get instant answers.',
    icon: aiIcon, badge: null, path: '/ai-assistant',
    permission: 'viewAIChatbot', colorKey: 'violet', category: 'AI',
  },
  {
    id: 'pipeline-studio',
    title: 'Pipeline Studio',
    description: 'Open any StreamSets pipeline to see its flow, stages and parameters, extract it, and validate the Oracle / MariaDB source against Snowflake. Results can be written back for the IT Checks page.',
    icon: pipelineIcon, badge: 'NEW', path: '/pipeline-studio',
    permission: 'runStreamsetsExtractor', colorKey: 'blue', category: 'Data',
    trail: [
      ['ssview', { stages: 'Stages', params: 'Parameters', validate: 'Validate', history: 'History' }],
    ],
  },
  {
    id: 'ingestion-lab',
    title: 'Ingestion Lab',
    description: 'Run your ingestion steps on the server, watch the live output and keep every run on record.',
    icon: validationIcon, badge: 'NEW', path: '/ingestion-lab',
    permission: 'viewIngestionLab', colorKey: 'gray', category: 'Data',
  },
  {
    id: 'data-api',
    title: 'Data API Export',
    description: 'Publish source tables as key-authenticated read-only APIs. Pick the columns, set a row limit, then hand out a URL that any tool can pull from on demand.',
    icon: dataApiIcon, badge: 'NEW', path: '/data-api',
    permission: 'manageDataAPIExports', colorKey: 'green', category: 'Data',
    // `api` is a user-created slug, so it is echoed back as-is rather than
    // looked up in a table.
    trail: [
      ['api', null],
      ['tab', {
        overview: 'Overview', tables: 'Tables', endpoints: 'Endpoints',
        docs: 'Docs', activity: 'Activity',
      }],
    ],
  },
  {
    id: 'unstructured',
    title: 'Unstructured Explorer',
    description: 'Explore unstructured document sets - Virtual Regulator, IMMBOT, RIMDocs, EPOD, FDA and more - with filterable tables and charts.',
    icon: unstructuredIcon, badge: null, path: '/unstructured-explorer',
    permission: 'viewUnstructured', colorKey: 'orange', category: 'Explorers',
    // Same order and permissions as the doctype tabs (UNSTRUCTURED_TABS in RBACContext).
    sections: [
      { label: 'Virtual Regulator', path: '/unstructured-explorer?doctype=vr',        permission: 'viewUnstructuredVR' },
      { label: 'IMMBOT',            path: '/unstructured-explorer?doctype=immbot',    permission: 'viewUnstructuredIMMBOT' },
      { label: 'MirAI',             path: '/unstructured-explorer?doctype=mirai',     permission: 'viewUnstructuredMirAI' },
      { label: 'RMWCreate',         path: '/unstructured-explorer?doctype=rmwcreate', permission: 'viewUnstructuredRMWCreate' },
      { label: 'Q!',                path: '/unstructured-explorer?doctype=haq',       permission: 'viewUnstructuredHAQ' },
      { label: 'Nipocalimab',       path: '/unstructured-explorer?doctype=nipo',      permission: 'viewUnstructuredNipo' },
      { label: 'RIMDocs',           path: '/unstructured-explorer?doctype=rimdocs',   permission: 'viewUnstructuredRimDocs' },
      { label: 'EPOD',              path: '/unstructured-explorer?doctype=epod',      permission: 'viewUnstructuredEPOD' },
      { label: 'FDA and Others',    path: '/unstructured-explorer?doctype=fda',       permission: 'viewUnstructuredFDA' },
    ],
    trail: [
      ['doctype', {
        vr: 'Virtual Regulator', immbot: 'IMMBOT', mirai: 'MirAI', rmwcreate: 'RMWCreate', haq: 'Q!',
        nipo: 'Nipocalimab', rimdocs: 'RIMDocs', epod: 'EPOD', fda: 'FDA and Others',
      }],
    ],
  },
  {
    id: 'gra-data-domains',
    title: 'Structured Explorer',
    description: 'Browse GRA data domains — sponsors, data stewards, and domain owners pulled live from Snowflake.',
    icon: infographicIcon, badge: null, path: '/gra-data-domains',
    permission: 'viewGraDataDomains', colorKey: 'red', category: 'Explorers',
  },
  {
    id: 'data-studio',
    title: 'Data Studio',
    description: 'Run SQL on Snowflake and Postgres, edit table rows in a live grid, browse S3 buckets and extract StreamSets pipeline reports — with filters, sorting, and exports to CSV, Excel, or JSON.',
    icon: dataStudioIcon, badge: 'NEW', path: '/data-studio',
    permission: 'viewDataStudio', colorKey: 'blue', category: 'Explorers',
    sections: [
      { label: 'Snowflake',   path: '/data-studio?pane=snowflake', permission: 'runSnowflakeQueryRunner' },
      { label: 'Postgres',    path: '/data-studio?pane=postgres',  permission: 'runPostgresStudio' },
      { label: 'Index Health', path: '/data-studio?pane=indexer',  permission: 'viewPGindexer' },
      { label: 'S3 Explorer', path: '/data-studio?pane=s3',        permission: 'runS3Explorer' },
      { label: 'StreamSets Extractor', path: '/data-studio?pane=streamsets', permission: 'runStreamsetsExtractor' },
      { label: 'Data Shuttle', path: '/data-studio?pane=shuttle', permission: 'runDataShuttle' },
    ],
    trail: [
      ['pane', { snowflake: 'Snowflake', postgres: 'Postgres', indexer: 'Index Health', s3: 'S3 Explorer', streamsets: 'StreamSets Extractor', shuttle: 'Data Shuttle' }],
    ],
  },
  {
    id: 'user-management',
    title: 'User Management',
    description: 'Manage user roles, permissions, and access controls across the platform. Assign AD group mappings and configure role-based access.',
    icon: gearIcon, badge: null, path: '/user-management',
    permission: 'viewUserManagement', colorKey: 'green', category: 'Admin',
    sections: [
      { label: 'Access Map', path: '/user-management?tab=groups' },
      { label: 'Roles',  path: '/user-management?tab=roles' },
      { label: 'Users',  path: '/user-management?tab=users' },
    ],
    trail: [
      ['tab', { groups: 'Groups', roles: 'Roles', users: 'Users' }],
    ],
  },
  {
    id: 'communication-center',
    title: 'Communication Center',
    description: 'Send updates, warnings and custom notices to portal users by email. Reuse saved templates and review everything that has been sent.',
    icon: commsIcon, badge: 'NEW', path: '/communication-center',
    permission: 'sendCommunications', colorKey: 'violet', category: 'Admin',
    sections: [
      { label: 'Compose',    path: '/communication-center?tab=compose' },
      { label: "What's New", path: '/communication-center?tab=whats-new' },
      { label: 'Queue',      path: '/communication-center?tab=queue' },
      { label: 'History',    path: '/communication-center?tab=history' },
    ],
    trail: [
      ['tab', {
        compose: 'Compose', 'whats-new': "What's New",
        queue: 'Queue', history: 'History',
      }],
    ],
  },
  {
    id: 'audit',
    title: 'Audit Log',
    description: 'See who is signed in right now and trace every sign-in, page view and role change across the portal, with filters and CSV export.',
    icon: auditIcon, badge: null, path: '/audit',
    permission: 'viewAudit', colorKey: 'orange', category: 'Admin',
  },
];

// NEW tools first, the rest in catalog order (sort is stable). The dashboard
// grid and the sidebar both go by this, so the two always agree.
export const newFirst = (tools) => [...tools].sort((a, b) => (b.badge === 'NEW') - (a.badge === 'NEW'));

// Paths, not ids - the sidebar's ids don't match the catalog's.
const DASHBOARD_ORDER = newFirst(TOOL_CATALOG).map(t => t.path);
export const dashboardRank = (path) => DASHBOARD_ORDER.indexOf(path);

export const findToolByPath = (pathname) =>
  TOOL_CATALOG.find(t => pathname === t.path || pathname.startsWith(`${t.path}/`));

// Turns a live URL into something worth showing in "pick up where you left
// off": which tool, and how deep into it the user actually was.
// Returns null for anything outside the catalogue (login, audit, dashboard).
export const describeLocation = (pathname, search) => {
  const tool = findToolByPath(pathname);
  if (!tool) return null;

  const params = new URLSearchParams(search || '');
  const trail = (tool.trail || []).reduce((steps, [param, labels]) => {
    const value = params.get(param);
    if (!value) return steps;
    // A null label table means the value is user data (an API slug, say) and
    // is shown verbatim; otherwise an unrecognised value is simply skipped.
    const label = labels ? labels[value] : value;
    return label ? [...steps, label] : steps;
  }, []);

  return {
    toolId: tool.id,
    path: `${pathname}${search || ''}`,
    trail,
  };
};