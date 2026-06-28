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
        className="bg-slate-950 text-slate-300 p-2 text-xs font-mono border-b border-slate-800 cursor-pointer hover:bg-slate-900 transition-colors"
        onClick={() => setIsModalOpen(true)}
      >
        <div className="flex items-center gap-2 mb-1">
           <Terminal size={14} className="text-sky-500" />
           <span className="truncate">{lastLog || 'No recent logs'}</span>
        </div>
        <div className="flex items-center gap-2">
           <UserCheck size={14} className="text-emerald-500" />
           <span>Active Sessions: {sessions.length} ({sessions.join(', ')})</span>
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
