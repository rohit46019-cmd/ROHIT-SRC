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
  Power
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { BotStatus } from './types';
import SystemStatusBar from './components/SystemStatusBar';

type Tab = 'home' | 'control' | 'config' | 'mirror';

export default function App() {
  const [data, setData] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [telegramSessions, setTelegramSessions] = useState<number[]>([]);

  // Operator Panel Forms
  const [singleTaskLink, setSingleTaskLink] = useState('');
  const [singleIsMirror, setSingleIsMirror] = useState(false);
  const [submittingSingleTask, setSubmittingSingleTask] = useState(false);

  const [batchStartLink, setBatchStartLink] = useState('');
  const [batchEndLink, setBatchEndLink] = useState('');
  const [batchIsMirror, setBatchIsMirror] = useState(false);
  const [submittingBatchTask, setSubmittingBatchTask] = useState(false);

  const [queueActionLoading, setQueueActionLoading] = useState(false);
  const [systemActionLoading, setSystemActionLoading] = useState(false);

  const handleSystemAction = async (endpoint: string) => {
    if (!confirm('Are you sure you want to execute this system command?')) return;
    setSystemActionLoading(true);
    try {
      const response = await fetch(`/api/system/${endpoint}`, { method: 'POST' });
      if (!response.ok) throw new Error('API Error');
      alert(`System action ${endpoint} sent successfully.`);
    } catch (e: any) {
      alert(`System action failed: ${e.message}`);
    } finally {
      setSystemActionLoading(false);
    }
  };

  const [mirrorHistory, setMirrorHistory] = useState<any[]>([]);
  const [failedTasks, setFailedTasks] = useState<any[]>([]);
  const [failedTasksLoading, setFailedTasksLoading] = useState(false);
  const [logSearch, setLogSearch] = useState('');
  const [logFilter, setLogFilter] = useState<'all' | 'success' | 'skipped' | 'failed'>('all');

  useEffect(() => {
    const fetchData = async () => {
      try {
        const fetchStatus = async () => {
          try {
            const res = await fetch('/api/status');
            return res.ok ? await res.json() : null;
          } catch (e) { return null; }
        };

        const fetchHistory = async () => {
          try {
            const res = await fetch('/api/mirrored/history');
            return res.ok ? await res.json() : null;
          } catch (e) { return null; }
        };

        const fetchFailed = async () => {
          try {
            const res = await fetch('/api/failed/list');
            return res.ok ? await res.json() : null;
          } catch (e) { return null; }
        };

        const fetchSessions = async () => {
          try {
            const res = await fetch('/api/sessions');
            return res.ok ? await res.json() : null;
          } catch (e) { return null; }
        };

        const fetchMirrorPaths = async () => {
          try {
            const res = await fetch('/api/settings/mirror-paths');
            return res.ok ? await res.json() : [];
          } catch (e) { return []; }
        };

        const [statusData, historyData, failedData, sessionsData, mirrorPathsData] = await Promise.all([
          fetchStatus(),
          fetchHistory(),
          fetchFailed(),
          fetchSessions(),
          fetchMirrorPaths()
        ]);

        if (statusData) {
          if (mirrorPathsData && statusData.settings) {
            statusData.settings.mirrorPaths = mirrorPathsData;
          }
          setData(statusData);
          setError(null);
        } else {
          // If status fails, we show a warning but don't necessarily crash the whole UI
          console.warn('Status fetch returned null');
        }

        if (historyData) {
          setMirrorHistory(historyData.logs || []);
        }

        if (failedData) {
          setFailedTasks(failedData.failed || []);
        }

        if (sessionsData) {
          setTelegramSessions(sessionsData || []);
        }

      } catch (err) {
        console.error('Frontend Fetch Group Error:', err);
        // Only set error if we have NO data at all
        if (!data) {
          setError(err instanceof Error ? err.message : 'Connection error');
        }
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 3000); // Fast feed updates
    return () => clearInterval(interval);
  }, []);

  // Real-time local countdown ticker for smooth, responsive decrementing on Dashboard
  useEffect(() => {
    const ticker = setInterval(() => {
      setData((prev) => {
        if (!prev) return null;
        const nextIn = prev.nextTaskIn && prev.nextTaskIn > 0 ? prev.nextTaskIn - 1 : 0;
        const activeJobs = prev.activeJobs?.map((job) => {
          if (job.phase === 'cooldown' && job.cooldownRemaining && job.cooldownRemaining > 0) {
            return {
              ...job,
              cooldownRemaining: job.cooldownRemaining - 1,
            };
          }
          return job;
        });
        return {
          ...prev,
          nextTaskIn: nextIn,
          activeJobs,
        };
      });
    }, 1000);
    return () => clearInterval(ticker);
  }, []);

  const [saving, setSaving] = useState(false);
  const [adminInput, setAdminInput] = useState('');
  const [sessionInput, setSessionInput] = useState('');
  const [destInput, setDestInput] = useState('');
  const [apiIdInput, setApiIdInput] = useState('');
  const [apiHashInput, setApiHashInput] = useState('');
  const [libSelection, setLibSelection] = useState('GramJS');
  const [uploadEngineSelection, setUploadEngineSelection] = useState('GramJS');
  const [renameRules, setRenameRules] = useState<Array<{ keyword: string; replaceWith: string }>>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newReplaceWith, setNewReplaceWith] = useState('');
  const [pathChatId, setPathChatId] = useState('');
  const [pathTopicId, setPathTopicId] = useState('');
  const [settingPath, setSettingPath] = useState(false);
  const [addingMirrorPath, setAddingMirrorPath] = useState(false);
  
  const [newMirrorSourceId, setNewMirrorSourceId] = useState('');
  const [newMirrorDestId, setNewMirrorDestId] = useState('');
  const [newMirrorTopicId, setNewMirrorTopicId] = useState('');
  
  const [cooldownInput, setCooldownInput] = useState('15');

  useEffect(() => {
    if (data?.settings) {
      setAdminInput(data.settings.adminId || '');
      setDestInput(data.settings.destinationChatId || '');
      setApiIdInput(data.settings.apiId || '');
      setApiHashInput(data.settings.apiHash || '');
      setLibSelection(data.settings.downloadLibrary || 'GramJS');
      setUploadEngineSelection(data.settings.uploadEngine || 'GramJS');
      if (data.settings.renameRules) {
        setRenameRules(data.settings.renameRules);
      }
      setCooldownInput(data.settings.cooldownSeconds?.toString() || '15');
    }
    if (data?.settings?.destinationChatId && !pathChatId) {
      setPathChatId(data.settings.destinationChatId);
    }
  }, [data?.settings]);

  const saveSettings = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adminId: adminInput,
          stringSession: sessionInput,
          destinationChatId: destInput,
          apiId: apiIdInput,
          apiHash: apiHashInput,
          downloadLibrary: libSelection,
          uploadEngine: uploadEngineSelection,
          renameRules: renameRules,
          cooldownSeconds: cooldownInput,
          proxy: data?.proxy
        })
      });
      if (!response.ok) throw new Error('Save failed');
      alert('Settings saved to MongoDB and synced successfully!');
      setSessionInput(''); // Clear sensitive user session textbox
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error settings path');
    } finally {
      setSaving(false);
    }
  };

  const handleQueueAction = async (action: 'pause' | 'resume' | 'clear') => {
    setQueueActionLoading(true);
    try {
      const response = await fetch(`/api/queue/${action}`, { method: 'POST' });
      if (!response.ok) throw new Error('Action failed');
    } catch (err: any) {
      alert(`Queue operational failure: ${err.message}`);
    } finally {
      setQueueActionLoading(false);
    }
  };

  const handleCancelTaskItem = async (index: number) => {
    try {
      const response = await fetch('/api/queue/cancel-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index })
      });
      if (!response.ok) throw new Error('Failed to cancel task item');
    } catch (err: any) {
      alert(`Error cancelling task item: ${err.message}`);
    }
  };

  const handlePrioritizeTaskItem = async (index: number) => {
    try {
      const response = await fetch('/api/queue/prioritize-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index })
      });
      if (!response.ok) throw new Error('Failed to prioritize task item');
    } catch (err: any) {
      alert(`Error prioritizing task item: ${err.message}`);
    }
  };

  const handleRetryFailedItem = async (id: string) => {
    setFailedTasksLoading(true);
    try {
      const response = await fetch('/api/failed/retry-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      if (!response.ok) throw new Error('Failed to retry task');
      setFailedTasks(prev => prev.filter(t => t.id !== id));
    } catch (err: any) {
      alert(`Error retrying task: ${err.message}`);
    } finally {
      setFailedTasksLoading(false);
    }
  };

  const handleRetryAllFailed = async () => {
    if (!confirm('Re-queue all failed copy lists back into the copy scheduling system now?')) return;
    setFailedTasksLoading(true);
    try {
      const response = await fetch('/api/failed/retry-all', { method: 'POST' });
      if (!response.ok) throw new Error('Failed to retry all items');
      const resJson = await response.json();
      alert(`Requeued ${resJson.count || 0} failed items successfully.`);
      setFailedTasks([]);
    } catch (err: any) {
      alert(`Error retrying all failed tasks: ${err.message}`);
    } finally {
      setFailedTasksLoading(false);
    }
  };

  const handleClearFailedLogs = async () => {
    if (!confirm('Erase all historical failed transfer attempts from the Atlas database? This is irreversible.')) return;
    setFailedTasksLoading(true);
    try {
      const response = await fetch('/api/failed/clear', { method: 'POST' });
      if (!response.ok) throw new Error('Failed to clear logging records');
      setFailedTasks([]);
    } catch (err: any) {
      alert(`Error clearing failed reports: ${err.message}`);
    } finally {
      setFailedTasksLoading(false);
    }
  };

  const handleClearMirrorHistory = async () => {
    if (!confirm('Are you absolutely sure you want to clear all history logs? Previously processed files can then be duplicated again.')) return;
    try {
      const response = await fetch('/api/mirrored/clear', { method: 'POST' });
      if (!response.ok) throw new Error('Failed to clear mirror history');
      setMirrorHistory([]);
    } catch (err: any) {
      alert(`Error clearing mirror history: ${err.message}`);
    }
  };

  const handleAddSingleTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!singleTaskLink.trim()) return;
    setSubmittingSingleTask(true);
    try {
      const response = await fetch('/api/queue/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          link: singleTaskLink.trim(),
          isMirror: singleIsMirror
        })
      });
      if (!response.ok) throw new Error('Failed to cache single task');
      setSingleTaskLink('');
      alert('✅ Single channel task successfully added to the active queue!');
    } catch (err: any) {
      alert(`Error queuing task: ${err.message}`);
    } finally {
      setSubmittingSingleTask(false);
    }
  };

  const handleAddBatchTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!batchStartLink.trim() || !batchEndLink.trim()) {
      alert('Missing start or end telegram message link');
      return;
    }
    setSubmittingBatchTask(true);
    try {
      const response = await fetch('/api/batch/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startLink: batchStartLink.trim(),
          endLink: batchEndLink.trim(),
          isMirror: batchIsMirror
        })
      });
      const resData = await response.json();
      if (!response.ok) throw new Error(resData.error || 'Failed to initialize range batch');
      setBatchStartLink('');
      setBatchEndLink('');
      alert(`✅ Range batch successfully queued! ${resData.count} message links scheduled.`);
    } catch (err: any) {
      alert(`Error executing dynamic batch range: ${err.message}`);
    } finally {
      setSubmittingBatchTask(false);
    }
  };

  const StatusBadge = ({ label, active, icon: Icon }: { label: string, active: boolean, icon: any }) => (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border transition-all ${
      active ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 font-bold' : 'bg-amber-500/10 border-amber-500/30 text-amber-400 font-bold'
    }`}>
      <Icon size={12} className={active ? 'animate-pulse' : ''} />
      <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
    </div>
  );

  const NavButton = ({ tab, icon: Icon, label }: { tab: Tab, icon: any, label: string }) => (
    <button 
      onClick={() => setActiveTab(tab)}
      className={`flex flex-col items-center gap-1 flex-1 py-3 px-2 transition-all relative ${
        activeTab === tab ? 'text-sky-500 font-extrabold' : 'text-slate-500 hover:text-slate-300'
      }`}
    >
      <Icon size={20} className={activeTab === tab ? 'scale-110' : ''} />
      <span className="text-[10px] font-bold uppercase tracking-tight">{label}</span>
      {activeTab === tab && (
        <motion.div layoutId="nav-pill" className="absolute -top-0.5 inset-x-4 h-0.5 bg-sky-500 rounded-full" />
      )}
    </button>
  );

  const renderHome = () => {
    const botName = data?.botInfo?.first_name || 'Bot Offline';
    const botUsername = data?.botInfo?.username ? `@${data.botInfo.username}` : 'No Username';
    const botStatus = data?.status || 'Stopped';
    const isRunning = botStatus === 'Running';
    const sessionCount = telegramSessions.length;
    const activeJob = data?.activeJobs && data?.activeJobs.length > 0 ? data.activeJobs[0] : null;
    const progressPercent = activeJob?.progress?.percent || 0;
    const activeSpeed = activeJob?.progress?.speed || '0 KB/s';
    const activeEta = activeJob?.progress?.eta || 'N/A';
    const activeCurrent = activeJob?.progress?.current || 0;
    const activeTotal = activeJob?.progress?.total || 0;
    const totalRemaining = data?.queueSize || 0;

    return (
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-24">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          
          {/* Card 1: Bot Identity (3D Style) */}
          <div className="bg-white dark:bg-[#0f172a] border-2 border-slate-200 dark:border-[#1e293b] p-6 rounded-2xl relative overflow-hidden group shadow-[6px_6px_0px_0px_rgba(14,165,233,0.3)] dark:shadow-[6px_6px_0px_0px_rgba(2,132,199,0.35)] transition-all hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[10px_10px_0px_0px_rgba(14,165,233,0.4)] dark:hover:shadow-[10px_10px_0px_0px_rgba(2,132,199,0.45)] duration-200">
            <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
              <Bot size={100} className="text-sky-500" />
            </div>
            <span className="text-slate-400 dark:text-slate-500 text-[10px] font-extrabold uppercase tracking-[0.25em] block mb-4">
              🤖 BOT IDENTITY
            </span>
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-gradient-to-br from-sky-400 to-blue-600 rounded-xl flex items-center justify-center text-white text-xl font-black shadow-[3px_3px_0px_0px_rgba(14,165,233,0.4)]">
                {botName[0]}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-slate-900 dark:text-white text-base font-black tracking-tight truncate">{botName}</h3>
                <p className="text-sky-500 font-mono text-xs font-bold leading-none mt-1 truncate">
                  {botUsername}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'} shrink-0`} />
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 font-bold uppercase tracking-wider">
                    Status: <span className={isRunning ? 'text-emerald-500 font-black' : 'text-rose-500 font-black'}>{botStatus}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: Telegram Accounts (3D Style) */}
          <div className="bg-white dark:bg-[#0f172a] border-2 border-slate-200 dark:border-[#1e293b] p-6 rounded-2xl relative overflow-hidden group shadow-[6px_6px_0px_0px_rgba(16,185,129,0.3)] dark:shadow-[6px_6px_0px_0px_rgba(16,185,129,0.35)] transition-all hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[10px_10px_0px_0px_rgba(16,185,129,0.4)] dark:hover:shadow-[10px_10px_0px_0px_rgba(16,185,129,0.45)] duration-200">
            <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
              <UserCheck size={100} className="text-emerald-500" />
            </div>
            <span className="text-slate-400 dark:text-slate-500 text-[10px] font-extrabold uppercase tracking-[0.25em] block mb-4">
              🔑 TELEGRAM LOGIN ID
            </span>
            <div className="flex flex-col justify-between h-[64px]">
              <div>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-bold">Connected Login Accounts</p>
                <div className="flex items-baseline gap-1.5 mt-1">
                  <span className="text-2xl font-black text-emerald-500 dark:text-emerald-400">{sessionCount}</span>
                  <span className="text-[10px] text-slate-400 uppercase font-bold tracking-tight">Active sessions</span>
                </div>
              </div>
              {sessionCount > 0 && (
                <div className="flex flex-wrap gap-1 mt-2 max-h-[24px] overflow-y-auto pr-1">
                  {telegramSessions.map((id, index) => (
                    <span key={`sess-${id}-${index}`} className="text-[9px] font-mono font-bold bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                      ID: {id}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Card 3: Download Progress Bar (3D Style) */}
          <div className="col-span-1 md:col-span-2 bg-white dark:bg-[#0f172a] border-2 border-slate-200 dark:border-[#1e293b] p-6 rounded-2xl relative overflow-hidden group shadow-[6px_6px_0px_0px_rgba(99,102,241,0.3)] dark:shadow-[6px_6px_0px_0px_rgba(99,102,241,0.35)] transition-all hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[10px_10px_0px_0px_rgba(99,102,241,0.4)] dark:hover:shadow-[10px_10px_0px_0px_rgba(99,102,241,0.45)] duration-200">
            <span className="text-slate-400 dark:text-slate-500 text-[10px] font-extrabold uppercase tracking-[0.25em] block mb-3">
              ⏳ CURRENT DOWNLOAD PROGRESS BAR
            </span>
            {activeJob ? (
              <div className="space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 border-b border-slate-100 dark:border-slate-800/80 pb-2">
                  <div className="min-w-0 flex-1">
                    <span className="text-[11px] font-bold text-slate-900 dark:text-white font-mono break-all">{activeJob.link}</span>
                  </div>
                  <span className="text-[8px] px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-bold uppercase self-start sm:self-center">
                    {activeJob.phase}
                  </span>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-xs font-bold">
                    <span className="text-emerald-500">Speed: <span className="font-mono">{activeSpeed}</span></span>
                    <span className="text-indigo-400 font-mono">ETA: {activeEta}</span>
                  </div>
                  <div className="h-3.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden border border-slate-200 dark:border-slate-700/80 p-0.5 shadow-inner">
                    <motion.div animate={{ width: `${progressPercent}%` }} className="h-full bg-gradient-to-r from-sky-500 to-emerald-500 rounded-full" />
                  </div>
                  <div className="flex justify-between items-center text-[9px] font-bold text-slate-400 uppercase tracking-wider">
                    <span>{Math.round(progressPercent)}% COMPLETED</span>
                    <span>{(activeCurrent / 1024 / 1024).toFixed(1)}MB / {(activeTotal / 1024 / 1024).toFixed(1)}MB</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-5 text-slate-400 dark:text-slate-500 space-y-1">
                <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800/60 flex items-center justify-center animate-pulse">
                  <Activity size={14} className="text-indigo-500/60" />
                </div>
                <p className="text-[10px] font-extrabold uppercase tracking-wider">No active downloads running</p>
                <p className="text-[9px] text-slate-500">The bot is waiting for link tasks to mirror.</p>
              </div>
            )}
          </div>

          {/* Card 4: Total Remaining (3D Style) */}
          <div className="col-span-1 md:col-span-2 bg-white dark:bg-[#0f172a] border-2 border-slate-200 dark:border-[#1e293b] p-6 rounded-2xl relative overflow-hidden group shadow-[6px_6px_0px_0px_rgba(245,158,11,0.3)] dark:shadow-[6px_6px_0px_0px_rgba(245,158,11,0.35)] transition-all hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[10px_10px_0px_0px_rgba(245,158,11,0.4)] dark:hover:shadow-[10px_10px_0px_0px_rgba(245,158,11,0.45)] duration-200">
            <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
              <Clock size={100} className="text-amber-500" />
            </div>
            <span className="text-slate-400 dark:text-slate-500 text-[10px] font-extrabold uppercase tracking-[0.25em] block mb-3">
              📊 TOTAL KITNA BAKI HAI (REMAINING QUEUE)
            </span>
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-bold mb-1">Queue Pipeline Size</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-black text-amber-500 dark:text-amber-400">{totalRemaining}</span>
                  <span className="text-xs text-slate-400 uppercase font-black tracking-wider">Tasks Left</span>
                </div>
              </div>
              <div className="bg-slate-50 dark:bg-slate-800/30 p-3 rounded-xl border border-slate-200/60 dark:border-[#1e293b] flex-1 w-full max-w-sm">
                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest block mb-1">Pipeline Engine</span>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-700 dark:text-slate-300">Automation Mode</span>
                  {data?.isQueuePaused ? (
                    <span className="text-[8px] font-extrabold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full uppercase tracking-wider">PAUSED</span>
                  ) : (
                    <span className="text-[8px] font-extrabold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full uppercase tracking-wider">RUNNING</span>
                  )}
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    );
  };

  const renderControl = () => (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Play/Pause/Wipe queue controls */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 sm:p-5 rounded-2xl shadow-md">
        <h2 className="text-slate-500 text-[9px] font-bold uppercase tracking-[0.2em] mb-2 flex items-center gap-2">
          <span>⚙️ OPERATIONAL INTERFACES & AUTOMATIC CONTROLS</span>
        </h2>
        <p className="text-slate-500 text-[11px] mb-4 leading-relaxed">
          Start/Stop tasks, clear pending download queues, and manage synchronization pipelines directly from this application console.
        </p>

        <div className="flex flex-wrap items-center gap-2 pb-4 border-b border-slate-100 dark:border-slate-800">
          <button 
            disabled={queueActionLoading}
            type="button"
            onClick={() => handleQueueAction(data?.isQueuePaused ? 'resume' : 'pause')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-bold uppercase tracking-wider transition-all disabled:opacity-50 shadow-sm ${
              data?.isQueuePaused 
                ? 'bg-emerald-500 hover:bg-emerald-600 text-white border-emerald-600' 
                : 'bg-amber-500 hover:bg-amber-600 text-white border-amber-600'
            }`}
          >
            {data?.isQueuePaused ? <Play size={12} /> : <Pause size={12} />}
            {data?.isQueuePaused ? 'Play Queue (Resume)' : 'Pause Queue'}
          </button>
          
          <button 
            disabled={queueActionLoading}
            type="button"
            onClick={() => {
              if (confirm('Verify: Do you want to purge all scheduled download tasks inside the bot queue?')) {
                handleQueueAction('clear');
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-500 hover:bg-rose-600 text-white border border-rose-600 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all disabled:opacity-50 shadow-sm"
          >
            <Trash size={12} />
            Wipe Cache Queue ({data?.queueSize || 0})
          </button>
        </div>

        {/* Dual Mode: Queue Single Link or Start Range Batch */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
          {/* Form 1: Add Single Task */}
          <form onSubmit={handleAddSingleTask} className="space-y-3">
            <h3 className="text-slate-900 dark:text-slate-200 text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 text-sky-500 dark:text-sky-400">
              <Link2 size={12} /> Queue Single Message Link
            </h3>
            <div>
              <p className="text-[10px] text-slate-500 mb-1.5">
                Paste any specific public or private Telegram message link to mirror or mirror-download instantly.
              </p>
              <input 
                type="text"
                placeholder="e.g. https://t.me/c/123456789/402"
                value={singleTaskLink}
                onChange={(e) => setSingleTaskLink(e.target.value)}
                className="w-full max-w-sm bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-lg px-2.5 py-1 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-sky-500/50 transition-all font-mono"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer text-[9px] uppercase font-bold text-slate-400 select-none">
                <input 
                  type="checkbox"
                  checked={singleIsMirror}
                  onChange={(e) => setSingleIsMirror(e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-700 text-sky-600 focus:ring-sky-500 w-3 h-3"
                />
                Act as Structured Mirror
              </label>
              <button 
                type="submit"
                disabled={submittingSingleTask || !singleTaskLink}
                className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[11px] uppercase tracking-wider rounded-lg transition-all disabled:opacity-50 shadow-sm"
              >
                {submittingSingleTask ? 'Processing...' : 'Queue Link'}
              </button>
            </div>
          </form>

          {/* Form 2: Batch Range Process */}
          <form onSubmit={handleAddBatchTask} className="space-y-3 border-t md:border-t-0 md:border-l border-slate-100 dark:border-slate-800/80 pt-4 md:pt-0 md:pl-4">
            <h3 className="text-slate-900 dark:text-slate-200 text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 text-indigo-500 dark:text-indigo-400">
              <Server size={12} /> Trigger Range Batch Sync
            </h3>
            <p className="text-[10px] text-slate-500">
              Enter a message scope range to perform batch synchronization. Highly scalable (Max 200 links).
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[8px] font-black uppercase text-slate-400 tracking-wider mb-0.5">Start Link</label>
                <input 
                  type="text"
                  placeholder="https://t.me/c/.../1"
                  value={batchStartLink}
                  onChange={(e) => setBatchStartLink(e.target.value)}
                  className="w-full max-w-sm bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500/50 transition-all font-mono"
                />
              </div>
              <div>
                <label className="block text-[8px] font-black uppercase text-slate-400 tracking-wider mb-0.5">End Link</label>
                <input 
                  type="text"
                  placeholder="https://t.me/c/.../50"
                  value={batchEndLink}
                  onChange={(e) => setBatchEndLink(e.target.value)}
                  className="w-full max-w-sm bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500/50 transition-all font-mono"
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer text-[9px] uppercase font-bold text-slate-400 select-none">
                <input 
                  type="checkbox"
                  checked={batchIsMirror}
                  onChange={(e) => setBatchIsMirror(e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500 w-3 h-3"
                />
                Act as Structured Mirror
              </label>
              <button 
                type="submit"
                disabled={submittingBatchTask || !batchStartLink || !batchEndLink}
                className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-[11px] uppercase tracking-wider rounded-lg transition-all disabled:opacity-50 shadow-sm"
              >
                {submittingBatchTask ? 'Processing...' : 'Start Web Batch'}
              </button>
            </div>
          </form>
        </div>
            {/* SETUP CHECKER */}
      <AnimatePresence>
        {!data?.config.hasToken || !data?.config.hasMongo || !data?.adminConfigured ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-rose-500/5 border border-rose-500/20 p-4 rounded-2xl"
          >
            <div className="flex items-center gap-2 mb-4">
              <AlertCircle size={16} className="text-rose-500" />
              <h3 className="text-slate-800 dark:text-white font-semibold text-xs">Critical Credentials Setup</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { active: data?.config.hasToken, label: 'Bot Token' },
                { active: data?.config.hasMongo, label: 'Database' },
                { active: data?.adminConfigured, label: 'Admin ID Set' },
                { active: data?.config.hasTarget, label: 'Target ID Set' }
              ].map((conf, i) => (
                <div key={i} className={`p-2.5 rounded-lg border flex flex-col items-center gap-1 text-center transition-colors ${
                  conf.active 
                    ? 'bg-emerald-500/5 dark:bg-emerald-500/10 border-emerald-500/20' 
                    : 'bg-rose-500/5 dark:bg-rose-500/10 border-rose-500/20'
                }`}>
                  {conf.active ? <CheckCircle2 size={14} className="text-emerald-500" /> : <XCircle size={14} className="text-rose-500" />}
                  <span className={`text-[9px] font-bold uppercase tracking-widest ${conf.active ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {conf.label}
                  </span>
                </div>
              ))}
            </div>
            <button 
              onClick={() => setActiveTab('config')}
              className="mt-4 w-full py-2 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-bold uppercase tracking-widest rounded-lg hover:opacity-90 transition-opacity"
            >
              Configure Credentials
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Real-time Task Live Feedback Streams */}
      {(data?.activeJobs && data?.activeJobs.length > 0) || (data?.batches && data?.batches.length > 0) ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 sm:p-5 rounded-2xl space-y-4 shadow-md">
          
          {/* Active Workload Jobs */}
          {data?.activeJobs && data?.activeJobs.length > 0 && (
            <div className="space-y-2.5">
              <h3 className="text-slate-400 text-[9px] font-bold uppercase tracking-[0.2em]">Active Sync Transfers</h3>
              {data.activeJobs.map((job, idx) => (
                <div key={`job-${job.progress?.eta || idx}-${idx}`} className="p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200/50 dark:border-slate-700/50 rounded-xl flex flex-col gap-1.5">
                  <div className="flex flex-wrap justify-between items-center gap-1.5 text-xs">
                    <span className="text-sky-500 font-mono text-[11px] font-bold truncate max-w-[240px] sm:max-w-md">{job.link}</span>
                    <span className="text-[10px] bg-sky-500/10 text-sky-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">{job.phase}</span>
                  </div>
                  {job.progress && (
                    <div className="space-y-1">
                      <div className="flex justify-between items-center text-[9px] font-bold">
                        <span className="text-emerald-400">{job.progress.speed || '0 KB/s'}</span>
                        <span className="text-slate-400 font-mono">ETA: {job.progress.eta || 'N/A'}</span>
                      </div>
                      <div className="h-2 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden shadow-inner">
                        <motion.div initial={{ width: 0 }} animate={{ width: `${job.progress.percent || 0}%` }} className="h-full bg-emerald-500 rounded-full" />
                      </div>
                      <div className="flex justify-between items-center text-[8px] text-slate-400 font-bold">
                        <span>{Math.round(job.progress.percent || 0)}% Completed</span>
                        <span>{(job.progress.current / 1024 / 1024).toFixed(1)}MB / {(job.progress.total / 1024 / 1024).toFixed(1)}MB</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Batches running monitor */}
          {data?.batches && data?.batches.length > 0 && (
            <div className="space-y-2.5 pt-3 border-t border-slate-100 dark:border-slate-800">
              <h3 className="text-slate-400 text-[9px] font-bold uppercase tracking-[0.2em]">Running Batches</h3>
              {data.batches.map((b, idx) => (
                <div key={`batch-${b.batchId || idx}-${idx}`} className="p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200/50 dark:border-slate-700/50 rounded-xl space-y-1.5">
                  <div className="flex justify-between items-center">
                    <span className="text-[11px] font-mono font-bold text-indigo-400 truncate max-w-[200px]">{b.batchId}</span>
                    <span className={`text-[8px] uppercase font-bold px-1.5 py-0.5 rounded ${b.isActive ? 'bg-orange-500/10 text-orange-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                      {b.isActive ? 'ACTIVE' : 'FINISHED'}
                    </span>
                  </div>
                  {b.currentLink && (
                    <div className="text-[9px] text-slate-500 truncate font-mono">
                      Current: <span className="text-sky-400">{b.currentLink}</span>
                    </div>
                  )}
                  <div className="space-y-1">
                    <div className="h-1 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-500" style={{ width: `${b.progress || 0}%` }}></div>
                    </div>
                    <div className="flex justify-between text-[8px] font-bold text-slate-400">
                      <span>{b.progress}% ({b.processed}/{b.total} messages processed)</span>
                      <span className="text-emerald-400">{b.success} Success | {b.failed} Failed</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* Queued tasks list status */}
      {data?.taskQueue && data?.taskQueue.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 sm:p-5 rounded-2xl shadow-md space-y-2.5">
          <div className="flex justify-between items-center mb-1">
            <h3 className="text-slate-500 dark:text-slate-400 text-[9px] font-bold uppercase tracking-[0.2em]">Upcoming Queue Feed ({data.taskQueue.length})</h3>
            <span className="text-[9px] text-slate-400 italic">Operate items directly below</span>
          </div>
          <div className="max-h-[300px] overflow-y-auto space-y-2 pr-1 custom-scrollbar">
            {data.taskQueue.map((t, idx) => (
              <div key={`queue-${t.link || idx}-${idx}`} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-xl text-xs hover:border-slate-300 dark:hover:border-slate-700 transition-all">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="text-[9px] font-black text-slate-400 font-mono">#{idx + 1}</span>
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-[11px] text-slate-600 dark:text-slate-300 break-all block">{t.link}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto">
                  <span className={`text-[8px] uppercase font-mono font-bold px-1.5 py-0.5 rounded border ${t.isMirror ? 'bg-indigo-500/10 text-indigo-500 border-indigo-500/25' : 'bg-sky-500/10 text-sky-500 border-sky-500/25'}`}>
                    {t.isMirror ? 'Mirror' : 'Direct'}
                  </span>
                  {idx > 0 && (
                    <button 
                      type="button"
                      onClick={() => handlePrioritizeTaskItem(idx)}
                      title="Bring to absolute top of queue"
                      className="p-1 bg-sky-5 dark:bg-sky-955/40 border border-sky-100 dark:border-sky-900/50 text-sky-600 dark:text-sky-400 rounded-md hover:bg-sky-100 dark:hover:bg-sky-900/60 transition-colors"
                    >
                      <ArrowUp size={12} />
                    </button>
                  )}
                  <button 
                     type="button"
                     onClick={() => {
                       if (confirm(`Cancel task #${idx + 1}: ${t.link}?`)) {
                         handleCancelTaskItem(idx);
                       }
                     }}
                     title="Cancel scheduling context"
                     className="p-1 bg-rose-50 dark:bg-rose-955/40 border border-rose-100 dark:border-rose-900/50 text-rose-600 dark:text-rose-450 rounded-md hover:bg-rose-100 dark:hover:bg-rose-900/60 transition-colors"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Failed Tasks & Sync Recovery Panel */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 sm:p-5 rounded-2xl shadow-md space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-slate-900 dark:text-white text-xs font-extrabold tracking-tight flex items-center gap-1.5">
              <AlertCircle className="text-rose-500 animate-pulse" size={14} />
              FAILED MIRRORS & RECOOLDOWN RECOVERIES ({failedTasks.length})
            </h2>
            <p className="text-[10px] text-slate-500 mt-0.5">
              Analyze copy/mirror operations that failed. Inspect error logs and retry or delete.
            </p>
          </div>
          {failedTasks.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <button
                 type="button"
                 disabled={failedTasksLoading}
                 onClick={handleRetryAllFailed}
                 className="px-2.5 py-1 bg-sky-500 hover:bg-sky-600 text-white border border-sky-600 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50 flex items-center gap-1"
              >
                <RefreshCw size={10} className={failedTasksLoading ? "animate-spin" : ""} />
                Retry All Failed
              </button>
              <button
                 type="button"
                 disabled={failedTasksLoading}
                 onClick={handleClearFailedLogs}
                 className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-600 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-colors disabled:opacity-50"
              >
                Clear Logs
              </button>
            </div>
          )}
        </div>

        {failedTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-6 bg-slate-50/50 dark:bg-slate-800/20 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl text-center">
            <CheckCircle2 className="text-emerald-500 mb-1.5" size={20} />
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">No Failed Mirror Operations!</p>
            <p className="text-[9px] text-slate-400 mt-0.5">All copies are successfully dispatched without errors.</p>
          </div>
        ) : (
          <div className="max-h-[300px] overflow-y-auto space-y-2 pr-1 custom-scrollbar">
            {failedTasks.map((t: any, idx: number) => {
              const parts = t.link.split('/');
              const msgId = parts[parts.length - 1] || 'Media';
              return (
                <div key={t._id || t.id + '-' + idx || idx} className="p-3 bg-rose-500/5 dark:bg-rose-955/10 border border-rose-500/20 dark:border-rose-900/30 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-rose-500/40 transition-all">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono text-[11px] font-bold text-slate-700 dark:text-slate-300 break-all block">
                        [Msg: {msgId}] {t.link}
                      </span>
                      {t.isMirror && (
                        <span className="text-[7px] font-extrabold uppercase bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-1 py-0.2 rounded">
                          Mirror Layout
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-rose-600 dark:text-rose-400 bg-rose-500/10 dark:bg-rose-950/25 px-2 py-1 rounded-md font-mono break-words leading-relaxed border border-rose-500/10">
                      <strong>Reason:</strong> {t.error || 'Unknown network error.'}
                    </p>
                    {t.failedAt && (
                      <p className="text-[8px] text-slate-400 font-medium">
                        {new Date(t.failedAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 self-end sm:self-auto uppercase tracking-wider">
                    <button
                      type="button"
                      disabled={failedTasksLoading}
                      onClick={() => handleRetryFailedItem(t.id)}
                      title="Retry copying this direct message link"
                      className="px-2 py-1 bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-900/40 text-sky-600 dark:text-sky-450 rounded-md hover:bg-sky-100 dark:hover:bg-sky-900/50 text-[9px] font-bold flex items-center gap-1 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw size={10} />
                      Retry
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>  </div>

      {/* Feature 3: Mirrored Logs & Destination History (Highlight Text Color, NO heavy blacks) */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 sm:p-5 rounded-2xl shadow-md space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-slate-900 dark:text-white text-xs font-extrabold tracking-tight flex items-center gap-1.5">
              <Sparkles className="text-amber-500 animate-pulse" size={14} />
              MIRRORED TRANSFER LOGS HISTORY
            </h2>
            <p className="text-[10px] text-slate-500 mt-0.5">
              Check all the successfully copied messages, skips, and failures in real-time.
            </p>
          </div>
          {mirrorHistory.length > 0 && (
            <button
               type="button"
               onClick={handleClearMirrorHistory}
               className="px-2.5 py-1 self-start sm:self-auto bg-rose-50 hover:bg-rose-100 border border-rose-200 hover:border-rose-400 text-rose-600 rounded-lg text-[9px] font-bold uppercase tracking-wider transition-colors"
            >
              Clear Log History
            </button>
          )}
        </div>

        {/* Searching & Quick Saturated Badges (High Contrast Text Highlighting) */}
        <div className="flex flex-col md:flex-row md:items-center gap-2">
          <input
            type="text"
            placeholder="Search logs by keyword..."
            value={logSearch}
            onChange={(e) => setLogSearch(e.target.value)}
            className="flex-1 bg-slate-100 dark:bg-slate-850 border border-slate-200 dark:border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:border-indigo-500/50 transition-colors"
          />
          <div className="flex flex-wrap gap-1.5">
            {[
              { id: 'all', label: '📸 All Logs', activeClass: 'bg-indigo-600 text-white border-indigo-750' },
              { id: 'success', label: '🟢 Success', activeClass: 'bg-emerald-600 text-white border-emerald-750' },
              { id: 'skipped', label: '🟡 Skipped', activeClass: 'bg-amber-500 text-white border-amber-655' },
              { id: 'failed', label: '🔴 Failed', activeClass: 'bg-rose-600 text-white border-rose-750' }
            ].map(btn => (
              <button
                key={btn.id}
                type="button"
                onClick={() => setLogFilter(btn.id as any)}
                className={`px-2 py-1 text-[10px] font-bold rounded-md border transition-all uppercase tracking-wider ${
                  logFilter === btn.id 
                    ? `${btn.activeClass} font-extrabold shadow-sm transform scale-[1.02]` 
                    : 'bg-slate-50 hover:bg-slate-100 dark:bg-slate-800/50 dark:hover:bg-slate-705 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>
        </div>

        {/* List of files */}
        <div className="max-h-[300px] overflow-y-auto space-y-2 pr-1 custom-scrollbar">
          {mirrorHistory.filter(log => {
            const matchesSearch = log.link?.toLowerCase().includes(logSearch.toLowerCase()) || 
                                  log.destId?.toLowerCase().includes(logSearch.toLowerCase()) ||
                                  log.info?.toLowerCase().includes(logSearch.toLowerCase());
            
            if (logFilter === 'all') return matchesSearch;
            return matchesSearch && log.status?.toLowerCase() === logFilter;
          }).length > 0 ? (
            mirrorHistory.filter(log => {
              const matchesSearch = log.link?.toLowerCase().includes(logSearch.toLowerCase()) || 
                                    log.destId?.toLowerCase().includes(logSearch.toLowerCase()) ||
                                    log.info?.toLowerCase().includes(logSearch.toLowerCase());
              
              if (logFilter === 'all') return matchesSearch;
              return matchesSearch && log.status?.toLowerCase() === logFilter;
            }).map((log, index) => {
              const dateStr = log.mirroredAt ? new Date(log.mirroredAt).toLocaleTimeString() : 'N/A';
              const isSuccess = log.status?.toLowerCase() === 'success';
              const isSkipped = log.status?.toLowerCase() === 'skipped';
              const isFailed = log.status?.toLowerCase() === 'failed';

              let badgeClass = '';
              if (isSuccess) badgeClass = 'text-emerald-700 bg-emerald-50 dark:text-emerald-450 dark:bg-emerald-950/40 border border-emerald-500/25';
              else if (isSkipped) badgeClass = 'text-amber-700 bg-amber-50 dark:text-amber-450 dark:bg-amber-950/40 border border-amber-500/25';
              else if (isFailed) badgeClass = 'text-rose-700 bg-rose-55 dark:text-rose-450 dark:bg-rose-950/40 border border-rose-500/25';

              return (
                <div key={index} className="p-3 bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-800 rounded-xl flex flex-col md:flex-row justify-between md:items-center gap-2.5 hover:border-slate-300 dark:hover:border-slate-700 transition-all">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`text-[8px] font-extrabold uppercase px-1.5 py-0.5 rounded tracking-wider ${badgeClass}`}>
                        {log.status}
                      </span>
                      <span className="text-[9px] font-mono text-slate-400">{dateStr}</span>
                    </div>
                    <span className="font-mono text-[11px] text-slate-750 dark:text-slate-300 break-all select-all block">
                      {log.link}
                    </span>
                    {log.info && (
                      <p className="text-[10px] text-slate-550 dark:text-slate-400 mt-1.5 font-medium bg-slate-100 dark:bg-slate-800/80 px-2 py-0.5 rounded border border-slate-200/50 dark:border-slate-700/50 w-fit">
                        ℹ️ {log.info}
                      </p>
                    )}
                  </div>
                  <div className="text-left shrink-0">
                    <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Destination target</p>
                    <p className="text-[10px] font-mono text-indigo-500 dark:text-indigo-400 font-bold bg-indigo-50 dark:bg-indigo-950/30 px-2 py-0.5 rounded-md border border-indigo-500/20 mt-0.5 max-w-[170px] truncate">
                      {log.destId}
                    </p>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-8 text-center bg-slate-50 dark:bg-slate-800/10 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
              <Sparkles className="mx-auto text-slate-450 mb-1.5 animate-pulse" size={18} />
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">No mirrored logs match search key</p>
              <p className="text-[9px] text-slate-400 mt-0.5">Initialize mirror actions to populate history</p>
            </div>
          )}
        </div>
      </div>

      {/* Systems Summary Information */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 sm:p-5 rounded-2xl shadow-md">
          <h2 className="text-slate-500 text-[9px] font-bold uppercase tracking-[0.2em] mb-4">Real-time Stream</h2>
          <div className="space-y-3">
            <div className="flex items-start gap-3 p-3 bg-slate-100 dark:bg-slate-800/40 rounded-xl border border-slate-200/50 dark:border-slate-800">
               <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-500 shrink-0">
                  <Database size={16} />
               </div>
               <div className="flex-1 min-w-0">
                 <div className="flex justify-between items-center mb-1">
                   <span className="text-[11px] font-bold text-slate-900 dark:text-white tracking-tight">Database Connectivity</span>
                   <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-bold uppercase ${data?.dbStatus === 'Connected' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}`}>
                     {data?.dbStatus || 'Searching...'}
                   </span>
                 </div>
                 <p className="text-[11px] text-slate-500 leading-relaxed">
                   Using MongoDB Atlas for cluster persistence. Rename rules and configuration are synced instantly.
                 </p>
               </div>
            </div>
            <div className="flex items-start gap-3 p-3 bg-slate-100 dark:bg-slate-800/40 rounded-xl border border-slate-200/50 dark:border-slate-800">
               <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-500 shrink-0">
                  <Shield size={16} />
               </div>
               <div className="flex-1 min-w-0">
                 <div className="flex justify-between items-center mb-1">
                   <span className="text-[11px] font-bold text-slate-900 dark:text-white tracking-tight">Admin Firewall</span>
                   <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-bold uppercase ${data?.adminConfigured ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'}`}>
                     {data?.adminConfigured ? 'Active' : 'Bypass'}
                   </span>
                 </div>
                 <p className="text-[11px] text-slate-500 leading-relaxed">
                   Command access is strictly verified against your authorized Admin ID to prevent unauthorized mirroring.
                 </p>
               </div>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 sm:p-5 rounded-2xl shadow-md">
          <h2 className="text-slate-500 text-[9px] font-bold uppercase tracking-[0.2em] mb-4">System Core Operations</h2>
          <div className="grid grid-cols-2 gap-3">
            <button 
              type="button"
              disabled={systemActionLoading}
              onClick={() => handleSystemAction('ping')}
              className="p-3 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-xl hover:border-emerald-500/45 transition-colors text-left flex flex-col justify-between h-[84px]"
            >
              <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-500">
                <Activity size={14} />
              </div>
              <div>
                <h4 className="text-slate-900 dark:text-white font-bold text-[10px] uppercase tracking-wider">Ping Instance</h4>
                <p className="text-[9px] text-slate-500 mt-0.5">Test response lag.</p>
              </div>
            </button>

            <button 
              type="button"
              disabled={systemActionLoading}
              onClick={() => handleSystemAction('cleartopics')}
              className="p-3 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-xl hover:border-amber-500/45 transition-colors text-left flex flex-col justify-between h-[84px]"
            >
              <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-500">
                <Trash2 size={14} />
              </div>
              <div>
                <h4 className="text-slate-900 dark:text-white font-bold text-[10px] uppercase tracking-wider">Wipe Cache</h4>
                <p className="text-[9px] text-slate-500 mt-0.5">Clear topic registry.</p>
              </div>
            </button>

            <button 
              type="button"
              disabled={systemActionLoading}
              onClick={() => handleSystemAction('restart')}
              className="p-3 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-xl hover:border-sky-500/45 transition-colors text-left flex flex-col justify-between h-[84px]"
            >
              <div className="w-7 h-7 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-500">
                <Power size={14} />
              </div>
              <div>
                <h4 className="text-slate-900 dark:text-white font-bold text-[10px] uppercase tracking-wider">Soft Restart</h4>
                <p className="text-[9px] text-slate-500 mt-0.5">Reboot background daemon.</p>
              </div>
            </button>

            <button 
              type="button"
              disabled={systemActionLoading}
              onClick={() => handleSystemAction('logout')}
              className="p-3 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 rounded-xl hover:border-rose-500/45 transition-colors text-left flex flex-col justify-between h-[84px]"
            >
              <div className="w-7 h-7 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-500">
                <LogOut size={14} />
              </div>
              <div>
                <h4 className="text-slate-900 dark:text-white font-bold text-[10px] uppercase tracking-wider">Kill Session</h4>
                <p className="text-[9px] text-slate-500 mt-0.5">Revoke internal session.</p>
              </div>
            </button>

            <button 
              type="button"
              disabled={systemActionLoading}
              onClick={() => handleSystemAction('reset')}
              className="col-span-2 p-3 bg-rose-500/5 dark:bg-rose-500/10 border border-rose-500/20 dark:border-rose-500/30 rounded-xl hover:bg-rose-500/10 dark:hover:bg-rose-500/20 hover:border-rose-500/50 transition-all text-left flex flex-col justify-between h-[96px]"
            >
              <div className="w-7 h-7 rounded-lg bg-rose-500/20 flex items-center justify-center text-rose-500 animate-pulse">
                <RefreshCw size={14} />
              </div>
              <div>
                <h4 className="text-rose-600 dark:text-rose-400 font-bold text-[10px] uppercase tracking-wider flex items-center gap-1.5">
                  Full System Reset <span className="text-[8px] px-1 bg-rose-500/15 text-rose-500 rounded font-normal uppercase tracking-normal">Safe Session</span>
                </h4>
                <p className="text-[9px] text-slate-500 mt-0.5 leading-normal">
                  Stops all active tasks/mirrors, clears queue, and soft restarts bot. Your login session is preserved.
                </p>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const renderConfig = () => (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-24">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 sm:p-8 rounded-3xl shadow-lg">
        <div className="flex items-center gap-3 mb-8">
          <Settings className="text-sky-500 animate-spin" size={24} style={{ animationDuration: '6s' }} />
          <div>
            <h2 className="text-slate-900 dark:text-white text-lg font-bold tracking-tight">Primary Configuration</h2>
            <p className="text-xs text-slate-500 tracking-wide">Sync core credentials with MongoDB persistence</p>
          </div>
        </div>

        <form onSubmit={saveSettings} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="group">
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 group-focus-within:text-sky-500 transition-colors">Admin User ID</label>
                <div className="relative">
                  <UserCheck className="absolute left-4 top-3.5 text-slate-500" size={16} />
                  <input 
                    type="text" 
                    value={adminInput}
                    onChange={(e) => setAdminInput(e.target.value)}
                    placeholder="e.g., 54321678"
                    className="w-full bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl pl-12 pr-4 py-3 text-sm focus:outline-none focus:border-sky-500/50 focus:ring-2 focus:ring-sky-500/5 transition-all text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Userbot String Session</label>
                <div className="relative">
                  <Shield className="absolute left-4 top-3.5 text-slate-500" size={16} />
                  <input 
                    type="password" 
                    value={sessionInput}
                    onChange={(e) => setSessionInput(e.target.value)}
                    placeholder={data?.config.hasSession ? '••••••••••••••••••••' : 'Paste new TGTX/GramJS session string'}
                    className="w-full bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl pl-12 pr-4 py-3 text-sm focus:outline-none focus:border-sky-500/50 transition-all text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Cooldown (seconds)</label>
                <div className="relative">
                  <Clock className="absolute left-4 top-3.5 text-slate-500" size={16} />
                  <input 
                    type="number"
                    value={cooldownInput}
                    onChange={(e) => setCooldownInput(e.target.value)}
                    placeholder="e.g., 15"
                    className="w-full bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl pl-12 pr-4 py-3 text-sm focus:outline-none focus:border-sky-500/50 transition-all text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Target Destination ID</label>
                <div className="relative">
                  <ExternalLink className="absolute left-4 top-3.5 text-slate-500" size={16} />
                  <input 
                    type="text" 
                    value={destInput}
                    onChange={(e) => setDestInput(e.target.value)}
                    placeholder="e.g., -100123456789"
                    className="w-full bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl pl-12 pr-4 py-3 text-sm focus:outline-none focus:border-sky-500/50 transition-all text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                  />
                </div>
              </div>

              <div className="pt-2">
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest">SOCKS5/HTTP Proxy (Optional)</label>
                  <button 
                    onClick={() => setData(data ? {...data, proxy: {ip: '45.12.189.155', port: 1080, socksType: 5}} : null)}
                    className="text-[10px] text-sky-500 hover:text-sky-400 font-extrabold uppercase transition-colors"
                  >
                    Magic Auto-Fill
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <input 
                    type="text" 
                    placeholder="Proxy IP/Host"
                    value={data?.proxy?.ip || ''}
                    onChange={(e) => setData(data ? {...data, proxy: {...(data.proxy || {ip: '', port: 1080}), ip: e.target.value}} : null)}
                    className="bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-xs focus:outline-none focus:border-sky-500/50 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                  />
                  <input 
                    type="number" 
                    placeholder="Port"
                    value={data?.proxy?.port || ''}
                    onChange={(e) => setData(data ? {...data, proxy: {...(data.proxy || {ip: '', port: 0}), port: parseInt(e.target.value)}} : null)}
                    className="bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-xs focus:outline-none focus:border-sky-500/50 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">App API ID</label>
                  <input 
                    type="text" 
                    value={apiIdInput}
                    onChange={(e) => setApiIdInput(e.target.value)}
                    placeholder="API ID"
                    className="w-full bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-sky-500/50 transition-all text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">App API Hash</label>
                  <input 
                    type="text" 
                    value={apiHashInput}
                    onChange={(e) => setApiHashInput(e.target.value)}
                    placeholder="API HASH"
                    className="w-full bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-sky-500/50 transition-all text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                  />
                </div>
              </div>

               <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-3">Download Engine</label>
                  <div className="grid grid-cols-2 gap-2">
                    {['Auto', 'GramJS', 'Telethon', 'Pyrogram', 'Hydrogram'].map((lib) => (
                      <button
                        key={lib}
                        type="button"
                        onClick={() => setLibSelection(lib)}
                        className={`py-3 rounded-2xl text-[10px] font-bold border transition-all ${
                          libSelection === lib 
                            ? 'bg-sky-600 border-sky-500 text-white shadow-md' 
                            : 'bg-slate-100 dark:bg-slate-800/80 border-slate-200 dark:border-slate-800 text-slate-500 hover:border-slate-400 dark:hover:border-slate-700'
                        }`}
                      >
                        {lib}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-bold text-emerald-500 dark:text-emerald-400 uppercase tracking-widest mb-3">Upload Engine</label>
                  <div className="grid grid-cols-2 gap-2">
                    {['Auto', 'GramJS', 'Telethon', 'Pyrogram', 'Hydrogram'].map((lib) => (
                      <button
                        key={lib}
                        type="button"
                        onClick={() => setUploadEngineSelection(lib)}
                        className={`py-3 rounded-2xl text-[10px] font-bold border transition-all ${
                          uploadEngineSelection === lib 
                            ? 'bg-emerald-600 border-emerald-500 text-white shadow-md' 
                            : 'bg-slate-100 dark:bg-slate-800/80 border-slate-200 dark:border-slate-800 text-slate-500 hover:border-slate-400 dark:hover:border-slate-700'
                        }`}
                      >
                        {lib}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-sky-500/5 dark:bg-sky-500/10 rounded-2xl p-4 border border-sky-500/25 flex items-start gap-3">
             <AlertCircle size={16} className="text-sky-500 shrink-0 mt-0.5" />
             <p className="text-[11px] text-slate-500 leading-relaxed">
               All settings above are encrypted and saved directly to your MongoDB Atlas collection. They will survive container restarts and server sleep modes.
             </p>
          </div>

          <button 
            type="submit"
            disabled={saving || !data?.config.hasMongo}
            className={`w-full py-4 rounded-xl font-bold text-xs uppercase tracking-[0.2em] transition-all flex items-center justify-center gap-2 transform active:scale-[0.98] ${
              saving 
                ? 'bg-slate-300 dark:bg-slate-800 text-slate-500 cursor-not-allowed' 
                : 'bg-sky-500 hover:bg-sky-600 hover:scale-[1.01] text-white shadow-lg'
            }`}
          >
            {saving ? <Activity className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
            {saving ? 'Syncing Portal...' : 'Commit Configuration'}
          </button>
        </form>
      </div>
    </div>
  );

  const renderRules = () => (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-24">
       <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 sm:p-8 rounded-3xl shadow-lg">
          <div className="flex items-center gap-3 mb-8">
            <div className="p-2.5 bg-sky-500/10 rounded-2xl text-sky-500">
              <Tag size={24} />
            </div>
            <div>
              <h2 className="text-slate-900 dark:text-white text-lg font-bold tracking-tight">Smart Renaming rules</h2>
              <p className="text-xs text-slate-500 tracking-wide">Automatic keyword replacement in captions & filenames</p>
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-slate-800/50 p-6 rounded-2xl border border-slate-200/50 dark:border-slate-800/80 mb-8">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-slate-500 mb-3 font-bold">Search For</label>
                <input 
                  type="text"
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  placeholder="e.g., @AdChannel_Bot"
                  className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-sky-500/50 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-slate-500 mb-3 font-bold">Replace With</label>
                <div className="flex gap-3">
                  <input 
                    type="text"
                    value={newReplaceWith}
                    onChange={(e) => setNewReplaceWith(e.target.value)}
                    placeholder="e.g., @MyBot"
                    className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-sky-500/50 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const word = newKeyword.trim();
                      if (!word) return;
                      if (renameRules.some(r => r.keyword === word)) return;
                      setRenameRules([...renameRules, { keyword: word, replaceWith: newReplaceWith }]);
                      setNewKeyword('');
                      setNewReplaceWith('');
                    }}
                    className="p-3 bg-sky-500 hover:bg-sky-600 text-white rounded-xl flex items-center justify-center transition-all shadow-md"
                  >
                    <Plus size={24} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
             <div className="flex justify-between items-center px-2">
               <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Active Rules Library ({renameRules.length})</span>
               <button 
                 onClick={() => setRenameRules([])}
                 className="text-[10px] text-rose-500 font-bold uppercase tracking-widest hover:text-rose-400 transition-colors"
               >
                 Flush All
               </button>
             </div>

             {renameRules.length === 0 ? (
               <div className="text-center py-16 border-2 border-dashed border-slate-200 dark:border-slate-800/50 rounded-2xl bg-slate-50 dark:bg-slate-800/10">
                  <Tag className="mx-auto text-slate-300 dark:text-slate-700 mb-4" size={48} />
                  <p className="text-sm font-bold text-slate-400 dark:text-slate-600 uppercase tracking-widest">No Active Match Patterns</p>
               </div>
             ) : (
               <div className="grid gap-3 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar">
                   {renameRules.map((rule, idx) => (
                     <motion.div 
                       key={idx} 
                       initial={{ opacity: 0, x: -10 }} 
                       animate={{ opacity: 1, x: 0 }}
                       className="group flex items-center justify-between gap-4 p-4 bg-slate-50 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-800/80 rounded-2xl hover:border-sky-500/25 transition-all"
                     >
                       <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
                          <div className="px-3 py-1 bg-rose-500/10 border border-rose-200 dark:border-rose-900 rounded-lg">
                             <span className="text-xs font-mono font-bold text-rose-500 dark:text-rose-400">{rule.keyword}</span>
                          </div>
                          <ArrowRight className="text-slate-400" size={14} />
                          <div className="px-3 py-1 bg-emerald-500/10 border border-emerald-200 dark:border-emerald-900 rounded-lg">
                             <span className="text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400 truncate max-w-[150px] block">
                               {rule.replaceWith || '(blank)'}
                             </span>
                          </div>
                       </div>
                       <button
                         type="button"
                         onClick={() => setRenameRules(renameRules.filter((_, rIdx) => rIdx !== idx))}
                         className="p-2.5 text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 rounded-xl transition-all"
                       >
                         <Trash2 size={16} />
                       </button>
                     </motion.div>
                   ))}
               </div>
             )}
          </div>

          {renameRules.length > 0 && (
             <button 
               onClick={() => saveSettings()}
               className="mt-12 w-full py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs uppercase tracking-[0.2rem] rounded-xl transition-all shadow-md"
             >
               Sync Rules to Cloud
             </button>
          )}
       </div>
    </div>
  );

  const handleDeleteMirrorPath = async (idx: number) => {
    if (!confirm('Delete this mirror path?')) return;
    try {
      const resp = await fetch('/api/mirror/delete-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: idx })
      });
      if (!resp.ok) throw new Error('API Error');
      alert('Mirror path deleted');
      // trigger refresh handled by interval
    } catch(err: any) {
      alert(err.message);
    }
  };

  const handleAddMirrorPath = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMirrorSourceId || !newMirrorDestId) return;
    setAddingMirrorPath(true);
    try {
      const resp = await fetch('/api/mirror/add-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceId: newMirrorSourceId,
          destId: newMirrorDestId,
          destThreadId: newMirrorTopicId,
          groupName: `Added from App UI`
        })
      });
      if (!resp.ok) throw new Error('API request failed');
      setNewMirrorSourceId('');
      setNewMirrorDestId('');
      setNewMirrorTopicId('');
      alert('Mirror path added');
    } catch(err: any) {
      alert(err.message);
    } finally {
      setAddingMirrorPath(false);
    }
  };

  const renderMirror = () => {
    const formatISTTime = (isoString?: string) => {
      if (!isoString) return 'Never checked';
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return 'Never checked';
      
      // Convert UTC to IST (+5:30)
      const istTime = new Date(d.getTime() + (5.5 * 60 * 60 * 1000));
      
      const pad = (num: number) => num.toString().padStart(2, '0');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      
      const day = pad(istTime.getUTCDate());
      const month = months[istTime.getUTCMonth()];
      const year = istTime.getUTCFullYear();
      
      let hours = istTime.getUTCHours();
      const minutes = pad(istTime.getUTCMinutes());
      const seconds = pad(istTime.getUTCSeconds());
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12; // 0 should be 12
      const strHours = pad(hours);
      
      return `${day} ${month} ${year}, ${strHours}:${minutes}:${seconds} ${ampm} (IST)`;
    };

    const handleSetPath = async () => {
      setSettingPath(true);
      try {
        const response = await fetch('/api/setpath', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: pathChatId,
            topicId: pathTopicId || null,
            groupTitle: 'Group from UI',
            topicName: pathTopicId ? `Topic ${pathTopicId}` : '',
            userId: data?.settings?.adminId || '6431447408'
          })
        });
        if (!response.ok) throw new Error('Failed to set path');
        alert('Mirroring configuration updated correctly!');
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Error setting path');
      } finally {
        setSettingPath(false);
      }
    };

    return (
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-24">
        
        {/* Global Mirror Fallback Target */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 sm:p-8 rounded-3xl shadow-lg">
          <h2 className="text-slate-900 dark:text-white text-lg font-bold tracking-tight mb-8">Global Mirror Destination</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Destination Chat ID</label>
              <input 
                type="text" 
                value={pathChatId}
                onChange={(e) => setPathChatId(e.target.value)}
                placeholder="e.g., -100XXXXXXX"
                className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-sky-500/50 text-slate-900 dark:text-slate-100 placeholder:text-slate-450"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Topic ID (Optional)</label>
              <input 
                type="text" 
                value={pathTopicId}
                onChange={(e) => setPathTopicId(e.target.value)}
                placeholder="e.g., 48"
                className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-sky-500/50 text-slate-900 dark:text-slate-100 placeholder:text-slate-450"
              />
            </div>
            <button 
              onClick={handleSetPath}
              disabled={settingPath}
              className="w-full py-4 bg-sky-500 hover:bg-sky-600 text-white font-bold text-xs uppercase tracking-[0.2rem] rounded-xl transition-all"
            >
              {settingPath ? 'Saving Destination Path...' : 'Apply Global Mapping Target'}
            </button>
          </div>
        </div>

        {/* Multi-Path Mapper */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 sm:p-8 rounded-3xl shadow-lg">
          <div className="flex items-center gap-3 mb-8">
            <Layers className="text-sky-500" size={24} />
            <div>
              <h2 className="text-slate-900 dark:text-white text-lg font-bold tracking-tight">Multi-Route Bindings</h2>
              <p className="text-xs text-slate-500 tracking-wide">Bind specific sources to exact destinations</p>
            </div>
          </div>
          
          <form onSubmit={handleAddMirrorPath} className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8 p-4 bg-slate-50 dark:bg-slate-800/40 rounded-2xl border border-slate-200 dark:border-slate-800">
            <div>
              <label className="block text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Source DB/Channel ID</label>
              <input type="text" value={newMirrorSourceId} onChange={e => setNewMirrorSourceId(e.target.value)} placeholder="-100..." className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-sky-500/50" />
            </div>
            <div>
              <label className="block text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Target Chat ID</label>
              <input type="text" value={newMirrorDestId} onChange={e => setNewMirrorDestId(e.target.value)} placeholder="-100..." className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-sky-500/50" />
            </div>
            <div>
              <label className="block text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">Target Topic (Optional)</label>
              <div className="flex gap-2">
                <input type="text" value={newMirrorTopicId} onChange={e => setNewMirrorTopicId(e.target.value)} placeholder="Topic ID" className="flex-1 min-w-0 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-sky-500/50" />
                <button type="submit" disabled={addingMirrorPath || !newMirrorSourceId || !newMirrorDestId} className="bg-sky-500 hover:bg-sky-600 text-white px-4 rounded-lg font-bold text-[10px] uppercase tracking-wider transition-all disabled:opacity-50">{addingMirrorPath ? 'Adding...' : 'Add'}</button>
              </div>
            </div>
          </form>

          <div className="space-y-4">
            <h3 className="text-slate-900 dark:text-slate-100 text-xs font-black tracking-widest uppercase text-slate-500/80 mb-1 font-display flex items-center gap-2">
              <Layers className="text-sky-500" size={14} /> Configured Route Bindings ({data?.settings?.mirrorPaths?.length || 0})
            </h3>
            {data?.settings?.mirrorPaths && data.settings.mirrorPaths.length > 0 ? (
              <div className="grid grid-cols-1 gap-4">
                {data.settings.mirrorPaths.map((path: any, idx: number) => {
                  const sourceTitle = path.sourceName || path.groupName || 'Source Channel';
                  const isLive = path.isLive !== false; // default to true if undefined
                  
                  return (
                    <div 
                      key={idx} 
                      className="group relative flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 bg-white dark:bg-[#070a13]/55 rounded-2xl border border-slate-200 dark:border-[#15203c] hover:border-sky-550/30 hover:shadow-lg dark:hover:shadow-sky-500/5 transition-all duration-300"
                    >
                      {/* Left Side: flow & ID labels info */}
                      <div className="flex-1 min-w-0 space-y-2">
                        {/* Title Row */}
                        <div className="flex flex-wrap items-center gap-1.5 text-sm">
                          <span className="text-slate-900 dark:text-slate-100 font-display font-semibold truncate max-w-[160px] sm:max-w-[220px]" title={sourceTitle}>
                            {sourceTitle}
                          </span>
                          
                          <span className="text-sky-500 font-bold mx-1 text-xs">➔</span>
                          
                          <span className="text-slate-800 dark:text-slate-200 font-display font-semibold truncate max-w-[160px] sm:max-w-[220px]" title={path.destGroupName || 'Destination'}>
                            {path.destGroupName || 'Destination'}
                          </span>
                          {path.destThreadId && (
                            <span className="text-[10px] font-mono font-semibold text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/15">
                              Topic: {path.destThreadId}
                            </span>
                          )}
                        </div>

                        {/* ID block row */}
                        <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400 font-mono">
                          <span className="bg-slate-105 dark:bg-[#0a0f1d] px-1.5 py-0.5 rounded border border-slate-200/50 dark:border-slate-805/60" title="Source Telegram ID">
                            SRC: {path.sourceId}
                          </span>
                          <span className="text-slate-300 dark:text-slate-800">|</span>
                          <span className="bg-slate-105 dark:bg-[#0a0f1d] px-1.5 py-0.5 rounded border border-slate-200/50 dark:border-slate-805/60" title="Destination Telegram ID">
                            DST: {path.destId}
                          </span>
                        </div>

                        {/* Scan Time Status */}
                        <div className="flex flex-wrap items-center gap-3 pt-2.5 border-t border-slate-100 dark:border-slate-850/50">
                          <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 font-sans text-[11px] font-semibold">
                            <Clock size={12} className="text-sky-500/70" />
                            <span>Last Scan (IST):</span>
                            <span className="font-mono text-slate-700 dark:text-slate-350 bg-slate-100 dark:bg-slate-800/80 px-2 py-0.5 rounded font-bold border border-slate-200/30 dark:border-slate-850">
                              {formatISTTime(path.lastScannedAt)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Right Side: Badges & Trash actions */}
                      <div className="flex items-center justify-between md:justify-end gap-3 pt-3 md:pt-0 border-t md:border-t-0 border-slate-100 dark:border-slate-850 shrink-0">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[9px] uppercase tracking-wider font-extrabold font-display ${
                          isLive 
                            ? 'text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 active-pulse' 
                            : 'text-amber-500 bg-amber-100/10 border border-amber-500/20'
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-550 animate-pulse' : 'bg-amber-500'}`} />
                          {isLive ? 'Live Scanner' : 'Offline'}
                        </span>

                        <button 
                          onClick={() => handleDeleteMirrorPath(idx)} 
                          className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-500/10 dark:hover:bg-red-500/10 transition-all bg-white dark:bg-[#070a13] rounded-xl border border-slate-200 dark:border-[#15203c]"
                          title="Delete Mapping"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 border border-dashed border-slate-200 dark:border-[#15203c] rounded-2xl bg-slate-50/50 dark:bg-slate-900/10">
                <Layers className="mx-auto text-slate-350 dark:text-slate-800 mb-2" size={24} />
                <p className="text-xs text-slate-500 italic font-medium leading-relaxed font-sans">No route bindings configured yet.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (loading && !data) return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center">
      <motion.div 
        animate={{ scale: [1, 1.1, 1], opacity: [0.5, 1, 0.5] }}
        transition={{ repeat: Infinity, duration: 2 }}
        className="text-sky-500"
      >
        <Bot size={64} />
      </motion.div>
    </div>
  );

  return (
    <div className={isDarkMode ? 'dark' : ''}>
      <div className="min-h-screen bg-slate-50 dark:bg-[#070a13] text-slate-800 dark:text-[#f1f5f9] font-sans selection:bg-emerald-500/30 pb-6 overflow-x-hidden flex transition-colors duration-300">
        
        {/* Desktop Sidebar (Permanent) */}
        <aside className="hidden lg:flex flex-col w-64 border-r border-slate-200/80 dark:border-[#15203c] bg-white dark:bg-[#0b1224] p-5 h-screen sticky top-0">
          <div className="flex items-center mb-8 pl-2">
            <h1 className="text-sm font-black text-slate-900 dark:text-white tracking-tighter flex items-center gap-2 font-display">
              <div className="p-1.5 bg-gradient-to-tr from-sky-500 to-emerald-500 rounded-md shrink-0 shadow-sm">
                 <Bot className="text-white animate-pulse" size={13} />
              </div>
              STUDIO <span className="text-sky-500 font-display">V3</span>
            </h1>
          </div>
          
          <nav className="flex flex-col gap-1.5 flex-1">
            <button onClick={() => setActiveTab('home')} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-bold transition-all font-display ${activeTab === 'home' ? 'bg-sky-500/10 text-sky-500 border-l-2 border-sky-500 shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'}`}>
              <Home size={14} /> Home
            </button>
            <button onClick={() => setActiveTab('control')} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-bold transition-all font-display ${activeTab === 'control' ? 'bg-sky-500/10 text-sky-500 border-l-2 border-sky-500 shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'}`}>
              <Zap size={14} /> Control
            </button>
            <button onClick={() => setActiveTab('config')} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-bold transition-all font-display ${activeTab === 'config' ? 'bg-sky-500/10 text-sky-500 border-l-2 border-sky-500 shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'}`}>
              <Settings size={14} /> Config
            </button>
            <button onClick={() => setActiveTab('mirror')} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-bold transition-all font-display ${activeTab === 'mirror' ? 'bg-sky-500/10 text-sky-500 border-l-2 border-sky-500 shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'}`}>
              <Layers size={14} /> Mirror / Rules
            </button>
          </nav>
        </aside>
 
        {/* Mobile/Tablet Overlay Sidebar */}
        <AnimatePresence>
          {isSidebarOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsSidebarOpen(false)}
                className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-40 lg:hidden"
              />
              <motion.aside
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
                className="fixed inset-y-0 left-0 w-64 bg-white dark:bg-[#0b1224] border-r border-slate-200 dark:border-[#15203c] z-50 flex flex-col p-4 shadow-2xl lg:hidden"
              >
                <div className="flex items-center justify-between mb-6 pl-1">
                  <h1 className="text-sm font-black text-slate-900 dark:text-white tracking-tighter flex items-center gap-2 font-display">
                    <div className="p-1.5 bg-gradient-to-tr from-sky-500 to-emerald-500 rounded-md shrink-0">
                       <Bot className="text-white animate-pulse" size={13} />
                    </div>
                    STUDIO <span className="text-sky-500 font-display">V3</span>
                  </h1>
                  <button onClick={() => setIsSidebarOpen(false)} className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                    <X size={16} />
                  </button>
                </div>
                
                <nav className="flex flex-col gap-1.5 flex-1">
                  <button onClick={() => { setActiveTab('home'); setIsSidebarOpen(false); }} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-bold transition-all font-display ${activeTab === 'home' ? 'bg-sky-500/10 text-sky-500' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'}`}>
                    <Home size={14} /> Home
                  </button>
                  <button onClick={() => { setActiveTab('control'); setIsSidebarOpen(false); }} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-bold transition-all font-display ${activeTab === 'control' ? 'bg-sky-500/10 text-sky-500' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'}`}>
                    <Zap size={14} /> Control
                  </button>
                  <button onClick={() => { setActiveTab('config'); setIsSidebarOpen(false); }} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-bold transition-all font-display ${activeTab === 'config' ? 'bg-sky-500/10 text-sky-500' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'}`}>
                    <Settings size={14} /> Config
                  </button>
                  <button onClick={() => { setActiveTab('mirror'); setIsSidebarOpen(false); }} className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-bold transition-all font-display ${activeTab === 'mirror' ? 'bg-sky-500/10 text-sky-500' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'}`}>
                    <Layers size={14} /> Mirror / Rules
                  </button>
                </nav>
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0 h-screen bg-slate-50 dark:bg-[#0a0f1c]">
            {/* Header */}
            <div className="sticky top-0 z-40 bg-slate-50/80 dark:bg-[#0a0f1c]/80 backdrop-blur-xl">
              <div className="max-w-4xl w-full mx-auto p-4 sm:px-6 lg:px-8 flex flex-col gap-3">
                 <SystemStatusBar />
                 <header className="flex items-center justify-between gap-4">
                   <div className="flex items-center gap-3">
                     <button onClick={() => setIsSidebarOpen(true)} className="lg:hidden p-1.5 rounded-lg bg-white dark:bg-[#0b1224] border border-slate-200 dark:border-[#15203c] text-slate-600 dark:text-slate-300 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                       <Menu size={16} />
                     </button>
                     <div className="hidden sm:flex items-center gap-2.5">
                        <StatusBadge label={data?.status || 'Unknown'} active={data?.status === 'Running'} icon={Activity} />
                        <StatusBadge label="Atlas DB" active={data?.dbStatus === 'Connected'} icon={Database} />
                     </div>
                   </div>
                   <div className="flex items-center gap-2">
                     <button onClick={() => setIsDarkMode(!isDarkMode)} className="p-1.5 rounded-lg border border-slate-200/80 dark:border-[#15203c] text-slate-600 dark:text-slate-450 hover:bg-white dark:hover:bg-[#15203c] transition-colors bg-white/50 dark:bg-transparent shadow-sm">
                       {isDarkMode ? '🌙' : '☀️'}
                     </button>
                   </div>
                 </header>
              </div>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
              <div className="max-w-4xl w-full mx-auto">
                <main className="space-y-6 pb-20 lg:pb-6">
                  {activeTab === 'home' && renderHome()}
                  {activeTab === 'control' && renderControl()}
                  {activeTab === 'config' && renderConfig()}
                  {activeTab === 'mirror' && (
                    <div className="space-y-6">
                      {renderMirror()}
                      {renderRules()}
                    </div>
                  )}
                </main>
              </div>
            </div>
        </div>

        {/* Persistent Bottom Nav for Mobile/Tablet */}
        <nav className="lg:hidden fixed bottom-0 inset-x-0 bg-white/95 dark:bg-[#0b1224]/95 backdrop-blur-2xl border-t border-slate-200 dark:border-[#15203c] px-4 py-1.5 z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.15)] dark:shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
          <div className="max-w-md mx-auto flex items-center justify-between gap-1">
            <NavButton tab="home" icon={Home} label="Home" />
            <NavButton tab="control" icon={Zap} label="Control" />
            <NavButton tab="config" icon={Settings} label="Config" />
            <NavButton tab="mirror" icon={Layers} label="Mirror/Rules" />
          </div>
        </nav>
      </div>
    </div>
  );
}
