import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useSearchParams, Navigate } from 'react-router-dom';
import { Sparkles, History, FileSearch } from 'lucide-react';
import { useRBAC } from '../context/RBACContext';
import { useAuth } from '../context/AuthContext';
import { logAuditEvent } from '../utils/auditLog';
import EPodRAG from './EPodRAG';
import RimDocsRAG from './RimDocsRAG';
import RimDocsAgentic from './RimDocsAgentic';

const ALL_TABS = [
  { id: 'rimdocs-agentic', label: 'RIMDocs Agentic', permission: 'viewRimDocsAgentic', component: RimDocsAgentic,
    icon: Sparkles, hint: 'Enterprise agentic search', badge: 'New' },
  { id: 'rimdocs', label: 'Rimdocs Legacy Agentic RAG', permission: 'viewRimDocsRAG', component: RimDocsRAG,
    icon: History, hint: 'Original RIMDocs chatbot', badge: 'Legacy' },
  { id: 'epod', label: 'EPOD RAG', permission: 'viewEPodRAG', component: EPodRAG,
    icon: FileSearch, hint: 'Ask EPOD documents' },
];

export default function RAGPage() {
  const { hasPermission } = useRBAC();
  const { user } = useAuth();
  const userEmail = user?.email || user?.username || 'unknown';
  const [searchParams, setSearchParams] = useSearchParams();

  const tabs = ALL_TABS.filter(t => hasPermission(t.permission));

  // Initialise from the URL, falling back to the first permitted tab.
  const [activeTab, setActiveTab] = useState(() => {
    const tab = searchParams.get('tab');
    if (tabs.some(t => t.id === tab)) return tab;
    return tabs[0]?.id ?? '';
  });

  const hasLoggedInitialTab = useRef(false);
  useEffect(() => {
    if (hasLoggedInitialTab.current || !activeTab) return;
    hasLoggedInitialTab.current = true;
    const label = ALL_TABS.find(t => t.id === activeTab)?.label || activeTab;
    logAuditEvent('rag_tab_viewed', userEmail, activeTab, `Landed on "${label}" tab on RAG page`);
  }, [activeTab, userEmail]);

  const handleTabChange = (id) => {
    if (id === activeTab) return;
    setActiveTab(id);
    setSearchParams({ tab: id });
    const label = ALL_TABS.find(t => t.id === id)?.label || id;
    logAuditEvent('rag_tab_viewed', userEmail, id, `Switched to "${label}" tab on RAG page`);
  };

  // Sync state when the browser navigates back/forward.
  useEffect(() => {
    const tab = searchParams.get('tab');
    const resolved = tabs.some(t => t.id === tab) ? tab : tabs[0]?.id ?? '';
    if (resolved !== activeTab) {
      setActiveTab(resolved);
      const label = ALL_TABS.find(t => t.id === resolved)?.label || resolved;
      logAuditEvent('rag_tab_viewed', userEmail, resolved,
        `Switched to "${label}" tab on RAG page via browser navigation`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Slide the underline to the active tab. ResizeObserver re-measures when
  // the web font loads or the layout changes, so it never lands off-target.
  const tabRefs = useRef({});
  const listRef = useRef(null);
  const [bar, setBar] = useState(null);
  const currentTab = tabs.some(t => t.id === activeTab) ? activeTab : tabs[0]?.id;
  useLayoutEffect(() => {
    const el = tabRefs.current[currentTab];
    if (!el) return;
    const move = () => setBar({ left: el.offsetLeft, width: el.offsetWidth });
    move();
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const ro = new ResizeObserver(move);
    ro.observe(el);
    if (listRef.current) ro.observe(listRef.current);
    return () => ro.disconnect();
  }, [currentTab, tabs.length]);

  // No permitted tabs — redirect to dashboard.
  if (tabs.length === 0) return <Navigate to="/dashboard" replace />;

  // Active tab is no longer permitted (e.g. role changed) — snap to first.
  const safeTab = tabs.some(t => t.id === activeTab) ? activeTab : tabs[0].id;
  const ActiveComponent = ALL_TABS.find(t => t.id === safeTab)?.component;

  // Arrow keys move between tabs (standard tablist behaviour).
  const onKeyDown = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex(t => t.id === safeTab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    handleTabChange(next.id);
    tabRefs.current[next.id]?.focus();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tab Bar */}
      <div className="sticky top-0 z-10 border-b border-jj-gray-05 bg-white shadow-[0_2px_6px_rgba(0,0,0,0.06)] px-1 sm:px-3">
        <div className="max-w-full overflow-x-auto px-3 pt-1 pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-sm:[mask-image:linear-gradient(to_right,transparent,#000_12px,#000_calc(100%-12px),transparent)]">
          <div
            ref={listRef}
            role="tablist"
            aria-label="RAG tools"
            onKeyDown={onKeyDown}
            className="relative inline-flex items-center gap-1"
          >
            {/* sliding charcoal pill */}
            {bar && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 rounded-md bg-jj-gray-08 shadow-[0_3px_8px_-4px_rgba(49,44,42,0.55)] transition-[left,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                style={{ left: bar.left, width: bar.width }}
              />
            )}

            {tabs.map((tab, i) => {
              const active = safeTab === tab.id;
              const Icon = tab.icon;
              return (
                <React.Fragment key={tab.id}>
                {i > 0 && (
                  <span
                    aria-hidden
                    className="mx-1 h-4 w-px shrink-0 bg-jj-gray-03"
                  />
                )}
                <button
                  ref={el => { tabRefs.current[tab.id] = el; }}
                  type="button"
                  role="tab"
                  id={`rag-tab-${tab.id}`}
                  aria-selected={active}
                  aria-controls="rag-tabpanel"
                  tabIndex={active ? 0 : -1}
                  title={tab.hint}
                  onClick={() => handleTabChange(tab.id)}
                  className={`group relative z-10 flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 font-johnson-text text-[13px] outline-none transition-[color,background-color,transform] duration-200 focus-visible:ring-2 focus-visible:ring-jj-red/50 focus-visible:ring-offset-2 active:scale-[0.97] ${
                    active ? 'font-semibold text-white' : 'font-medium text-jj-gray-06 hover:bg-jj-gray-01 hover:text-jj-gray-08'
                  }`}
                >
                  <Icon
                    size={14}
                    strokeWidth={2}
                    aria-hidden
                    className={`transition-colors duration-200 ${active ? 'text-jj-red' : 'text-jj-gray-05 group-hover:text-jj-gray-07'}`}
                  />
                  {tab.label}
                  {tab.badge && (
                    <span className={`rounded-full px-1.5 py-[3px] text-[9px] font-bold uppercase leading-none tracking-wider transition-colors duration-200 ${
                      tab.badge === 'New'
                        ? (active ? 'bg-jj-red text-white' : 'bg-jj-red/10 text-jj-red')
                        : `ring-1 ring-inset ${active ? 'ring-white/30 text-white/80' : 'ring-jj-gray-04 text-jj-gray-06'}`
                    }`}>
                      {tab.badge}
                    </span>
                  )}
                </button>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* Tab Content */}
      <div id="rag-tabpanel" role="tabpanel" aria-labelledby={`rag-tab-${safeTab}`} className="flex-1 overflow-auto">
        {ActiveComponent && <ActiveComponent />}
      </div>
    </div>
  );
}