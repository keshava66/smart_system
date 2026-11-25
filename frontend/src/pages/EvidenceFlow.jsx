import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import aiIcon from "/icons/JJ_Icon_AI_RGB.svg";
import refreshIcon from "/icons/JJ_Icon_Refresh_RGB.svg";
import loadingVideo from "/spinner.mp4";

// Embedded the same way as the EPOD / RIMDocs RAG pages. No URL set = coming soon.
const EVIDENCEFLOW_URL = import.meta.env.VITE_API_EVIDENCEFLOW_URL;

const Card = ({ title, children }) => (
  <div className="h-full flex items-center justify-center p-5 bg-jj-gray-01">
    <div className="bg-white border border-jj-gray-02 rounded-[14px] shadow-[0_1px_3px_rgba(49,44,42,.05)] px-12 py-10 text-center max-w-md">
      <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-jj-red/10 flex items-center justify-center">
        <img src={aiIcon} alt="" className="w-5 h-5" />
      </div>
      <div className="font-johnson-display font-bold text-[26px] tracking-wide text-jj-red leading-none mb-2">EvidenceFlow</div>
      <div className="font-johnson-display font-bold text-[20px] text-jj-gray-08">{title}</div>
      {children}
    </div>
  </div>
);

const btn = "px-[18px] py-[9px] rounded-full text-[12.5px] font-johnson-text font-medium transition-colors";

function ComingSoon() {
  const navigate = useNavigate();
  return (
    <Card title="Coming soon">
      <div className="text-[12.5px] font-johnson-text text-jj-gray-06 mt-2">We're still building this page. Check back soon.</div>
      <button onClick={() => navigate("/dashboard")} className={`mt-5 bg-jj-gray-08 text-white hover:bg-black ${btn}`}>
        Back to dashboard
      </button>
    </Card>
  );
}

export default function EvidenceFlow() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  if (!EVIDENCEFLOW_URL) return <ComingSoon />;

  const retry = () => { setError(false); setLoading(true); setAttempt(a => a + 1); };

  return (
    <div className="h-full relative bg-jj-gray-01">
      <iframe
        key={attempt}
        src={EVIDENCEFLOW_URL}
        title="EvidenceFlow"
        className={`absolute inset-0 w-full h-full border-0 transition-opacity duration-300 ${loading ? "opacity-0" : "opacity-100"}`}
        onLoad={() => { setLoading(false); setError(false); }}
        onError={() => { setLoading(false); setError(true); }}
        allow="clipboard-read; clipboard-write"
        // allow-downloads so Export CSV works inside the frame
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
      />

      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-jj-gray-01 z-10">
          <div className="text-center">
            <div className="w-32 h-32 mx-auto mb-4 rounded-full overflow-hidden shadow-lg">
              <video autoPlay loop muted playsInline className="w-full h-full object-cover">
                <source src={loadingVideo} type="video/mp4" />
              </video>
            </div>
            <p className="text-jj-gray-07 font-johnson-text text-lg">Loading EvidenceFlow...</p>
            <p className="text-jj-gray-05 font-johnson-text text-sm mt-2">Please wait while we connect to the service</p>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-10">
          <Card title="Unable to load">
            <div className="text-[12.5px] font-johnson-text text-jj-gray-06 mt-2">
              The EvidenceFlow service didn't respond. It may be down or blocked on this network.
            </div>
            <div className="mt-5 flex justify-center gap-2">
              <button onClick={retry} className={`bg-jj-red text-white hover:bg-jj-maroon-05 flex items-center gap-1.5 ${btn}`}>
                <img src={refreshIcon} alt="" className="w-3.5 h-3.5" style={{ filter: "brightness(0) invert(1)" }} />
                Retry
              </button>
              <button
                onClick={() => window.open(EVIDENCEFLOW_URL, "_blank", "noopener,noreferrer")}
                className={`border border-jj-gray-03 text-jj-gray-07 hover:bg-jj-gray-01 ${btn}`}
              >
                Open in new tab
              </button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
