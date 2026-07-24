import React, { useEffect, useRef, useState } from 'react';
import { Terminal, Search, Trash2, ChevronDown, ChevronUp, Filter } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface LogViewerProps {
  onClear: () => void;
}

export default function LogViewer({ onClear }: LogViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const res = await fetch('/api/logs');
        if (res.ok) {
          const data = await res.json();
          setLogs(data.logs || []);
        }
      } catch (e) {
        console.error('Failed to fetch logs');
      }
    };

    const interval = setInterval(fetchLogs, 2000);
    fetchLogs();
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll, isExpanded]);

  const clearLogs = async () => {
    try {
      await fetch('/api/logs/clear', { method: 'POST' });
      setLogs([]);
      onClear();
    } catch (e) {
      console.error('Failed to clear logs');
    }
  };

  const filteredLogs = logs.filter(log => 
    log.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className={`glass-panel rounded-xl overflow-hidden transition-all duration-300 ${isExpanded ? 'h-[500px]' : 'h-64'}`}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50">
        <div className="flex items-center gap-2">
          <Terminal size={14} className="text-sky-500" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Live System Console</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
            <input 
              type="text" 
              placeholder="Filter..." 
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-sky-500/30 w-32"
            />
          </div>
          <button 
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1 rounded transition-colors ${autoScroll ? 'text-sky-500 bg-sky-500/10' : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
            title="Auto-scroll"
          >
            <ChevronDown size={12} className={autoScroll ? 'animate-bounce' : ''} />
          </button>
          <button 
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          <button 
            onClick={clearLogs}
            className="p-1 rounded text-rose-400 hover:bg-rose-500/10 transition-colors"
            title="Clear logs"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      
      <div 
        ref={scrollRef}
        className="p-2 h-full overflow-y-auto font-mono text-[10px] leading-relaxed custom-scrollbar bg-black/5 dark:bg-black/20"
      >
        <AnimatePresence initial={false}>
          {filteredLogs.length > 0 ? (
            filteredLogs.map((log, i) => (
              <div key={i} className="py-0.5 border-b border-black/5 dark:border-white/5 last:border-0 hover:bg-sky-500/5 transition-colors">
                <span className="text-slate-400">[{i + 1}]</span> {log}
              </div>
            ))
          ) : (
            <div className="flex items-center justify-center h-full text-slate-500 italic opacity-50">
              No logs matches current filter...
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
