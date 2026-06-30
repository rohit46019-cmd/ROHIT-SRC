import React, { useEffect, useState } from 'react';
import { Terminal, UserCheck, X } from 'lucide-react';

export default function SystemStatusBar() {
  const [logs, setLogs] = useState<string[]>([]);
  const [sessions, setSessions] = useState<number[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);

  useEffect(() => {
    const fetchSystemStatus = async () => {
      try {
        const [logsRes, sessionsRes] = await Promise.all([fetch('/api/logs'), fetch('/api/sessions')]);
        if (logsRes.ok) setLogs(await logsRes.json());
        if (sessionsRes.ok) setSessions(await sessionsRes.json());
      } catch (e) { console.error(e); }
    };
    fetchSystemStatus();
    const interval = setInterval(fetchSystemStatus, 15000);
    return () => clearInterval(interval);
  }, []);

  const lastLog = logs[logs.length - 1];

  return (
    <>
      <div 
        className="bg-slate-950 dark:bg-slate-900/40 text-slate-300 p-1.5 px-3 text-[10px] font-mono border border-slate-800/80 rounded-xl cursor-pointer hover:bg-slate-900 transition-all shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-1.5"
        onClick={() => setIsModalOpen(true)}
      >
        <div className="flex items-center gap-1.5 min-w-0">
           <Terminal size={11} className="text-sky-500 shrink-0" />
           <span className="truncate">{lastLog || 'No recent logs'}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 text-[9px] bg-slate-900 dark:bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800 w-fit">
           <UserCheck size={11} className="text-emerald-500" />
           <span className="font-bold">Active Sessions: {sessions.length}</span>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950 p-4 overflow-y-auto">
          <div className="flex justify-between items-center mb-4 sticky top-0 bg-slate-950 pb-2 border-b border-slate-800">
            <h2 className="text-lg font-bold text-slate-100">System Logs (Last 200)</h2>
            <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white">
              <X size={24} />
            </button>
          </div>
          <div className="font-mono text-xs text-slate-300 whitespace-pre-wrap">
            {logs.slice(-200).reverse().map((log, i) => (
              <div key={i} className="mb-1 border-b border-slate-900 pb-1">{log}</div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
