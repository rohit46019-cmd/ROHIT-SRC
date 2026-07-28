import React, { useEffect, useState } from 'react';
import { 
  Bot, 
  Shield, 
  AlertCircle, 
  CheckCircle2, 
  Settings, 
  ExternalLink, 
  Database, 
  UserCheck, 
  XCircle, 
  Plus, 
  Trash2, 
  Tag, 
  Home, 
  FileEdit, 
  Layers, 
  Clock, 
  ArrowRight, 
  ArrowUp,
  Activity, 
  Pause, 
  Play, 
  Trash,
  Sparkles,
  Link2,
  Server,
  RefreshCw,
  Menu,
  X,
  Zap,
  LogOut,
  Power,
  Terminal,
  Search,
  Filter,
  Code
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { BotStatus } from './types';
import SystemStatusBar from './components/SystemStatusBar';
import LogViewer from './components/LogViewer';
import MirrorPathManager from './components/MirrorPathManager';
import BottomNav from './components/BottomNav';
import { CompactCard, SectionHeader } from './components/UIElements';

type Tab = 'home' | 'control' | 'mirror' | 'config' | 'system';

export default function App() {
  const [data, setData] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [telegramSessions, setTelegramSessions] = useState<number[]>([]);

  // Forms
  const [singleLink, setSingleLink] = useState('');
  const [singleIsMirror, setSingleIsMirror] = useState(true);
  const [batchStart, setBatchStart] = useState('');
  const [batchEnd, setBatchEnd] = useState('');
  const [batchIsMirror, setBatchIsMirror] = useState(true);
  const [batchIsFast, setBatchIsFast] = useState(true);
  const [batchIsBot, setBatchIsBot] = useState(false);
  
  // Settings
  const [adminId, setAdminId] = useState('');
  const [destId, setDestId] = useState('');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [cooldown, setCooldown] = useState('5');
  const [saving, setSaving] = useState(false);
  const [batchBaseUrl, setBatchBaseUrl] = useState('');

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statusRes, historyRes, failedRes, sessionsRes] = await Promise.all([
          fetch('/api/status'),
          fetch('/api/mirrored/history'),
          fetch('/api/failed/list'),
          fetch('/api/sessions')
        ]);

        const statusData = statusRes.ok && statusRes.headers.get('content-type')?.includes('application/json') ? await statusRes.json() : null;
        const historyData = historyRes.ok && historyRes.headers.get('content-type')?.includes('application/json') ? await historyRes.json() : null;
        const failedData = failedRes.ok && failedRes.headers.get('content-type')?.includes('application/json') ? await failedRes.json() : null;
        const sessionsData = sessionsRes.ok && sessionsRes.headers.get('content-type')?.includes('application/json') ? await sessionsRes.json() : [];

        if (statusData) {
          setData(statusData);
          setAdminId(statusData.settings?.adminId || '');
          setDestId(statusData.settings?.destinationChatId || '');
          setApiId(statusData.settings?.apiId || '');
          setApiHash(statusData.settings?.apiHash || '');
          setCooldown(statusData.settings?.cooldownSeconds?.toString() || '5');
        }
        if (historyData) setMirrorHistory(historyData.logs || []);
        if (failedData) setFailedTasks(failedData.failed || []);
        setTelegramSessions(sessionsData);
      } catch (err) {
        console.error('Fetch error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleSystemAction = async (action: string, method: string = 'POST') => {
    if (!confirm(`Confirm system action: ${action}?`)) return;
    try {
      const res = await fetch(`/api/system/${action}`, { method });
      if (res.ok) alert(`${action} executed successfully`);
      else throw new Error('Action failed');
    } catch (e: any) {
      alert(`Error: ${e.message}`);
    }
  };

  const handleQueueAction = async (action: string) => {
    try {
      await fetch(`/api/queue/${action}`, { method: 'POST' });
    } catch (e) {
      alert('Queue action failed');
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminId,
          destinationChatId: destId,
          apiId,
          apiHash,
          cooldownSeconds: cooldown
        })
      });
      if (res.ok) alert('Settings updated');
      else throw new Error('Save failed');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleMirrorAction = async (action: string) => {
    try {
      await fetch(`/api/mirrored/${action}`, { method: 'POST' });
      if (action === 'clear') setMirrorHistory([]);
    } catch (e) { alert('Action failed'); }
  };

  const handleFailedAction = async (action: string) => {
    try {
      await fetch(`/api/failed/${action}`, { method: 'POST' });
      if (action === 'clear') setFailedTasks([]);
    } catch (e) { alert('Action failed'); }
  };

  const handleBatchStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!batchBaseUrl || !batchStart || !batchEnd) return alert("Please fill all batch fields.");
    
    // Construct links as expected by server
    const baseUrl = batchBaseUrl.endsWith('/') ? batchBaseUrl : batchBaseUrl + '/';
    const startLink = baseUrl + batchStart;
    const endLink = baseUrl + batchEnd;

    try {
      const res = await fetch('/api/batch/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          startLink, 
          endLink, 
          isMirror: batchIsMirror,
          isForwardOnly: batchIsFast || batchIsBot, // Treat bot forward as a type of forward-only
          isBotForward: batchIsBot
        })
      });
      if (res.ok) {
        alert('Batch task queued');
        setBatchStart('');
        setBatchEnd('');
      } else {
        const err = await res.json();
        alert('Error: ' + (err.error || 'Failed to start batch'));
      }
    } catch (e) {
      alert('Network error starting batch');
    }
  };

  const StatusBadge = ({ label, active, icon: Icon }: { label: string, active: boolean, icon: any }) => (
    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[9px] font-bold uppercase tracking-wider transition-all ${
      active ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500' : 'bg-rose-500/10 border-rose-500/20 text-rose-500'
    }`}>
      <Icon size={10} className={active ? 'animate-pulse' : ''} />
      {label}
    </div>
  );

  const NavItem = ({ tab, icon: Icon, label }: { tab: Tab, icon: any, label: string }) => (
    <button
      onClick={() => { setActiveTab(tab); setIsSidebarOpen(false); }}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[11px] font-bold transition-all ${
        activeTab === tab 
          ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/20' 
          : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800/60'
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );

  const renderHome = () => (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <CompactCard title="Bot Status" icon={<Bot size={14} />} subtitle={data?.botInfo?.username || 'Offline'}>
          <div className="flex flex-col gap-2 mt-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-slate-500">Service</span>
              <span className={`text-[10px] font-bold ${data?.status === 'Running' ? 'text-emerald-500' : 'text-rose-500'}`}>{data?.status}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-slate-500">Sessions</span>
              <span className="text-[10px] font-bold text-sky-500">{telegramSessions.length} Active</span>
            </div>
          </div>
        </CompactCard>

        <CompactCard title="Queue Engine" icon={<Activity size={14} />} subtitle="Real-time metrics">
          <div className="flex flex-col gap-2 mt-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-slate-500">Tasks Left</span>
              <span className="text-[10px] font-bold text-amber-500">{data?.queueSize || 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-slate-500">State</span>
              <span className="text-[10px] font-bold text-sky-500">{data?.isQueuePaused ? 'Paused' : 'Running'}</span>
            </div>
          </div>
        </CompactCard>

        <CompactCard title="Memory Usage" icon={<Database size={14} />} subtitle="Database health">
          <div className="flex flex-col gap-2 mt-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-slate-500">MongoDB</span>
              <span className={`text-[10px] font-bold ${data?.dbStatus === 'Connected' ? 'text-emerald-500' : 'text-rose-500'}`}>{data?.dbStatus}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-slate-500">Admin</span>
              <span className="text-[10px] font-bold text-slate-400 truncate max-w-[80px]">{data?.settings?.adminId || 'Not set'}</span>
            </div>
          </div>
        </CompactCard>
      </div>

      <CompactCard title="Active Transmissions" icon={<RefreshCw size={14} />} className="md:col-span-3">
        {data?.activeJobs && data.activeJobs.length > 0 ? (
          <div className="space-y-3">
            {data.activeJobs.map((job, i) => (
              <div key={i} className="p-2 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-800">
                <div className="flex justify-between items-center mb-1.5">
                  <span className="text-[10px] font-mono font-bold text-slate-400 truncate max-w-[70%]">{job.link}</span>
                  <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-500">{job.phase}</span>
                </div>
                {job.progress && (
                  <div className="space-y-1">
                    <div className="h-1.5 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }} 
                        animate={{ width: `${job.progress.percent}%` }} 
                        className="h-full bg-sky-500" 
                      />
                    </div>
                    <div className="flex justify-between text-[8px] font-bold text-slate-400 uppercase">
                      <span>{job.progress.percent.toFixed(1)}% ({job.progress.speed})</span>
                      <span>ETA: {job.progress.eta}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-6 opacity-40">
            <Activity size={24} className="mb-2" />
            <span className="text-[10px] font-bold uppercase tracking-widest">No active tasks in pipeline</span>
          </div>
        )}
      </CompactCard>
    </div>
  );

  const renderControl = () => (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CompactCard title="Queue Controller" icon={<Zap size={14} />}>
          <div className="flex flex-wrap gap-2">
            <button 
              onClick={() => handleQueueAction(data?.isQueuePaused ? 'resume' : 'pause')}
              className={`btn-primary flex-1 flex items-center justify-center gap-2 ${data?.isQueuePaused ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-amber-500 hover:bg-amber-600'}`}
            >
              {data?.isQueuePaused ? <Play size={12} /> : <Pause size={12} />}
              {data?.isQueuePaused ? 'Resume' : 'Pause'}
            </button>
            <button 
              onClick={() => handleQueueAction('clear')}
              className="btn-danger flex-1 flex items-center justify-center gap-2"
            >
              <Trash2 size={12} /> Clear Queue
            </button>
          </div>
        </CompactCard>

        <CompactCard title="Quick Mirror" icon={<Link2 size={14} />}>
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <input 
                type="text" 
                placeholder="Telegram Link..."
                value={singleLink}
                onChange={(e) => setSingleLink(e.target.value)}
                className="flex-1 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-sky-500/50 font-mono"
              />
              <button 
                onClick={async () => {
                   if (!singleLink) return;
                   await fetch('/api/queue/add', {
                     method: 'POST',
                     headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify({ link: singleLink, isMirror: singleIsMirror })
                   });
                   setSingleLink('');
                }}
                className="btn-primary"
              >Queue</button>
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={singleIsMirror} onChange={e => setSingleIsMirror(e.target.checked)} className="rounded border-slate-300 dark:border-slate-700" />
              <span className="text-[10px] font-bold text-slate-500 uppercase">Enable Mirror</span>
            </label>
          </div>
        </CompactCard>
      </div>

      <CompactCard title="Batch Processing" icon={<Layers size={14} />}>
        <form onSubmit={handleBatchStart} className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2">
            <input 
              type="text" 
              placeholder="Base URL (e.g. t.me/channel/)"
              value={batchBaseUrl}
              onChange={e => setBatchBaseUrl(e.target.value)}
              className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs font-mono"
            />
          </div>
          <input 
            type="number" 
            placeholder="Start ID"
            value={batchStart}
            onChange={e => setBatchStart(e.target.value)}
            className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs"
          />
          <input 
            type="number" 
            placeholder="End ID"
            value={batchEnd}
            onChange={e => setBatchEnd(e.target.value)}
            className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 text-xs"
          />
          <div className="md:col-span-4 flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={batchIsMirror} onChange={e => setBatchIsMirror(e.target.checked)} className="rounded border-slate-300 dark:border-slate-700" />
              <span className="text-[10px] font-bold text-slate-500 uppercase">Batch Mirror</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={batchIsFast} onChange={e => setBatchIsFast(e.target.checked)} className="rounded border-slate-300 dark:border-slate-700" />
              <span className="text-[10px] font-bold text-slate-500 uppercase">Fast Forward</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none" title="Bot ID se forward karega (Bot Account)">
              <input type="checkbox" checked={batchIsBot} onChange={e => setBatchIsBot(e.target.checked)} className="rounded border-slate-300 dark:border-slate-700" />
              <span className="text-[10px] font-bold text-slate-500 uppercase">Bot ID Forward</span>
            </label>
            <div className="flex-1" />
            <button type="submit" className="btn-primary px-8">Start Batch Job</button>
          </div>
        </form>
      </CompactCard>

      <LogViewer onClear={() => {}} />
    </div>
  );

  const renderConfig = () => (
    <form onSubmit={saveSettings} className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <SectionHeader title="Deep Configuration" subtitle="Update core system credentials and parameters" icon={<Settings size={14} />} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[
          { label: 'Admin ID', value: adminId, setter: setAdminId, placeholder: 'e.g. 6431447408' },
          { label: 'Target Chat ID', value: destId, setter: setDestId, placeholder: 'e.g. -100...' },
          { label: 'API ID', value: apiId, setter: setApiId, placeholder: 'Telegram API ID' },
          { label: 'API Hash', value: apiHash, setter: setApiHash, placeholder: 'Telegram API Hash' },
          { label: 'Cooldown (s)', value: cooldown, setter: setCooldown, placeholder: '5' },
        ].map((field, i) => (
          <div key={i} className="space-y-1">
            <label className="text-[10px] font-bold uppercase text-slate-500 tracking-widest">{field.label}</label>
            <input 
              type="text" 
              value={field.value}
              onChange={e => field.setter(e.target.value)}
              placeholder={field.placeholder}
              className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-sky-500/50 font-mono"
            />
          </div>
        ))}
      </div>
      <button 
        type="submit" 
        disabled={saving}
        className="btn-primary w-full py-2.5 shadow-lg shadow-sky-500/20"
      >
        {saving ? 'Updating System...' : 'Apply & Save Config'}
      </button>
    </form>
  );

  const renderSystem = () => (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <SectionHeader title="System Maintenance" subtitle="Critical operations and hardware management" icon={<Shield size={14} />} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {[
          { icon: <RefreshCw size={14} />, label: 'Soft Restart', action: 'restart' },
          { icon: <Trash2 size={14} />, label: 'Hard Reset', action: 'reset' },
          { icon: <Terminal size={14} />, label: 'Clear Topics', action: 'cleartopics' },
          { icon: <Power size={14} />, label: 'Log Out Client', action: 'logout' },
          { icon: <Zap size={14} />, label: 'Ping Test', action: 'ping' },
        ].map((item, i) => (
          <button 
            key={i}
            onClick={() => handleSystemAction(item.action)}
            className="flex flex-col items-center justify-center p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl hover:border-sky-500/50 hover:shadow-lg transition-all group"
          >
            <div className="p-2 bg-slate-100 dark:bg-slate-800 rounded-full mb-2 group-hover:bg-sky-500/10 group-hover:text-sky-500 transition-colors">
              {item.icon}
            </div>
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500 group-hover:text-slate-900 dark:group-hover:text-white transition-colors">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  const [mirrorHistory, setMirrorHistory] = useState<any[]>([]);
  const [failedTasks, setFailedTasks] = useState<any[]>([]);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const [historyRes, failedRes] = await Promise.all([
          fetch('/api/mirrored/history'),
          fetch('/api/failed/list')
        ]);
        if (historyRes.ok) {
          const hData = await historyRes.json();
          setMirrorHistory(hData.logs || []);
        }
        if (failedRes.ok) {
          const fData = await failedRes.json();
          setFailedTasks(fData.failed || []);
        }
      } catch (e) {}
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 10000);
    return () => clearInterval(interval);
  }, []);

  const renderMirror = () => (
     <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
       <SectionHeader title="Mirror Engine" subtitle="Configure mappings and view transmission history" icon={<Layers size={14} />} />
       
       <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
         <div className="lg:col-span-2 space-y-6">
            <CompactCard title="Recent History" subtitle="Last 20 mirrored messages" icon={<Clock size={14} />}>
                <div className="flex justify-end mb-2">
                  <button onClick={() => handleMirrorAction('clear')} className="text-[9px] font-bold text-rose-500 uppercase hover:underline">Clear History</button>
                </div>
                <div className="max-h-80 overflow-y-auto custom-scrollbar space-y-1 pr-1">
                  {mirrorHistory.length > 0 ? mirrorHistory.slice(0, 20).map((log, i) => (
                    <div key={i} className="p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg flex flex-col gap-0.5">
                      <span className="text-[10px] font-mono font-bold text-sky-500 truncate">{log.link}</span>
                      <div className="flex items-center justify-between">
                        <span className="text-[8px] font-bold text-slate-400 uppercase">{new Date(log.mirroredAt).toLocaleString()}</span>
                        <span className="text-[8px] font-bold text-emerald-500 uppercase">{log.status}</span>
                      </div>
                    </div>
                  )) : (
                    <div className="text-center py-8 opacity-30 text-[10px] font-bold uppercase tracking-widest">No history available</div>
                  )}
                </div>
            </CompactCard>

            <CompactCard title="Failed Pipeline" subtitle="Error tracking and recovery" icon={<AlertCircle size={14} />}>
                <div className="flex justify-end gap-3 mb-2">
                  <button onClick={() => handleFailedAction('retry-all')} className="text-[9px] font-bold text-sky-500 uppercase hover:underline">Retry All</button>
                  <button onClick={() => handleFailedAction('clear')} className="text-[9px] font-bold text-rose-500 uppercase hover:underline">Clear All</button>
                </div>
                <div className="max-h-80 overflow-y-auto custom-scrollbar space-y-1 pr-1">
                  {failedTasks.length > 0 ? failedTasks.map((task, i) => (
                    <div key={i} className="p-2 bg-rose-500/5 border border-rose-500/20 rounded-lg flex flex-col gap-0.5">
                      <span className="text-[10px] font-mono font-bold text-rose-500 truncate">{task.link}</span>
                      <div className="flex items-center justify-between">
                        <span className="text-[8px] font-bold text-slate-400 uppercase truncate max-w-[200px]">Error: {task.error}</span>
                        <button 
                          onClick={async () => {
                            await fetch('/api/failed/retry-item', { 
                              method: 'POST', 
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ id: task.id || task._id }) 
                            });
                          }}
                          className="text-[8px] font-bold text-sky-500 uppercase hover:underline"
                        >Retry</button>
                      </div>
                    </div>
                  )) : (
                    <div className="text-center py-8 opacity-30 text-[10px] font-bold uppercase tracking-widest">Pipeline clean - No failures</div>
                  )}
                </div>
            </CompactCard>
         </div>

         <div className="space-y-6">
           <CompactCard title="Path Management" icon={<Tag size={14} />}>
              <MirrorPathManager />
           </CompactCard>
         </div>
       </div>
     </div>
  );

  return (
    <div className={isDarkMode ? 'dark' : ''}>
      <div className="min-h-screen bg-slate-50 dark:bg-[#020617] text-slate-900 dark:text-slate-200 flex overflow-hidden">
        
        {/* Sidebar */}
        <aside className={`fixed inset-y-0 left-0 w-52 bg-white dark:bg-[#0b1224] border-r border-slate-200 dark:border-slate-900 z-50 transition-transform duration-300 lg:static lg:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className="h-full flex flex-col p-4">
            <div className="flex items-center gap-2 mb-8 px-2">
              <div className="p-1.5 bg-sky-500 rounded-lg text-white shadow-lg shadow-sky-500/20">
                <Bot size={14} />
              </div>
              <span className="text-sm font-black tracking-tighter uppercase font-display">Studio <span className="text-sky-500">V4</span></span>
            </div>

            <nav className="flex-1 flex flex-col gap-1.5">
              <NavItem tab="home" icon={Home} label="Dashboard" />
              <NavItem tab="control" icon={Zap} label="Control" />
              <NavItem tab="mirror" icon={Layers} label="Mirroring" />
              <NavItem tab="config" icon={Settings} label="Settings" />
              <NavItem tab="system" icon={Shield} label="System" />
            </nav>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
              <button 
                onClick={() => setIsDarkMode(!isDarkMode)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[11px] font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-all"
              >
                {isDarkMode ? <Sparkles size={14} /> : <XCircle size={14} />}
                {isDarkMode ? 'Light Mode' : 'Dark Mode'}
              </button>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <div className="flex-1 flex flex-col h-screen overflow-hidden">
          <header className="h-14 border-b border-slate-200 dark:border-slate-900 bg-white/50 dark:bg-[#0b1224]/50 backdrop-blur-md flex items-center justify-between px-4 lg:px-8 shrink-0">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-3">
                <StatusBadge label={data?.status || 'Offline'} active={data?.status === 'Running'} icon={Activity} />
                <StatusBadge label="MongoDB" active={data?.dbStatus === 'Connected'} icon={Database} />
              </div>
            </div>
            
            <div className="flex items-center gap-4">
              <div className="hidden sm:flex flex-col items-end">
                <span className="text-[10px] font-black text-slate-400 uppercase leading-none">Account</span>
                <span className="text-[10px] font-bold text-sky-500">{data?.botInfo?.first_name || 'Disconnected'}</span>
              </div>
              <div className="w-8 h-8 rounded-full bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-500">
                <Bot size={16} />
              </div>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto p-4 lg:p-8 pb-24 lg:pb-8 custom-scrollbar">
            <div className="max-w-4xl mx-auto space-y-6">
              <SystemStatusBar />
              {activeTab === 'home' && renderHome()}
              {activeTab === 'control' && renderControl()}
              {activeTab === 'mirror' && renderMirror()}
              {activeTab === 'config' && renderConfig()}
              {activeTab === 'system' && renderSystem()}
            </div>
          </main>
          <BottomNav activeTab={activeTab} setActiveTab={setActiveTab} />
        </div>
      </div>
    </div>
  );
}
