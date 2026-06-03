import React, { useEffect, useState } from 'react';
import { Bot, Shield, AlertCircle, CheckCircle2, Settings, ExternalLink, Database, UserCheck, XCircle, Plus, Trash2, Tag, Home, FileEdit, Layers, Clock, ArrowRight, Activity } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { BotStatus } from './types';

type Tab = 'dashboard' | 'config' | 'rules' | 'mirror' | 'system';

export default function App() {
  const [data, setData] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [isDarkMode, setIsDarkMode] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch('/api/status');
        if (!response.ok) throw new Error('Failed to fetch status');
        const json = await response.json();
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 3000); // Faster refresh for countdown
    return () => clearInterval(interval);
  }, []);

  const [saving, setSaving] = useState(false);
  const [adminInput, setAdminInput] = useState('');
  const [sessionInput, setSessionInput] = useState('');
  const [destInput, setDestInput] = useState('');
  const [apiIdInput, setApiIdInput] = useState('');
  const [apiHashInput, setApiHashInput] = useState('');
  const [libSelection, setLibSelection] = useState('GramJS');
  const [renameRules, setRenameRules] = useState<Array<{ keyword: string; replaceWith: string }>>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newReplaceWith, setNewReplaceWith] = useState('');
  const [pathChatId, setPathChatId] = useState('');
  const [pathTopicId, setPathTopicId] = useState('');
  const [settingPath, setSettingPath] = useState(false);
  const [cooldownInput, setCooldownInput] = useState('15');

  useEffect(() => {
    if (data?.settings) {
      setAdminInput(data.settings.adminId || '');
      setDestInput(data.settings.destinationChatId || '');
      setApiIdInput(data.settings.apiId || '');
      setApiHashInput(data.settings.apiHash || '');
      setLibSelection(data.settings.downloadLibrary || 'GramJS');
      if (data.settings.renameRules) {
        setRenameRules(data.settings.renameRules);
      }
      setCooldownInput(data.settings.cooldownSeconds?.toString() || '15');
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
          renameRules: renameRules,
          cooldownSeconds: cooldownInput,
          proxy: data?.proxy
        })
      });
      if (!response.ok) throw new Error('Save failed');
      alert('Settings persistent in MongoDB!');
      setSessionInput(''); // Clear secret
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error saving');
    } finally {
      setSaving(false);
    }
  };

  const StatusBadge = ({ label, active, icon: Icon }: { label: string, active: boolean, icon: any }) => (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border transition-all ${
      active ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
    }`}>
      <Icon size={12} />
      <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
    </div>
  );

  const NavButton = ({ tab, icon: Icon, label }: { tab: Tab, icon: any, label: string }) => (
    <button 
      onClick={() => setActiveTab(tab)}
      className={`flex flex-col items-center gap-1 flex-1 py-3 px-2 transition-all relative ${
        activeTab === tab ? 'text-blue-500' : 'text-slate-500 hover:text-slate-300'
      }`}
    >
      <Icon size={20} className={activeTab === tab ? 'scale-110' : ''} />
      <span className="text-[10px] font-bold uppercase tracking-tight">{label}</span>
      {activeTab === tab && (
        <motion.div layoutId="nav-pill" className="absolute -top-0.5 inset-x-4 h-0.5 bg-blue-500 rounded-full" />
      )}
    </button>
  );

  const renderDashboard = () => (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Bot Identity & Queue */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 p-8 rounded-[2rem] relative overflow-hidden group shadow-2xl shadow-blue-500/5">
          <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
            <Bot size={120} />
          </div>
          <h2 className="text-slate-500 text-[10px] font-bold uppercase tracking-[0.2em] mb-8">Bot Identity</h2>
          {data?.botInfo ? (
            <div className="flex items-center gap-5">
              <div className="w-20 h-20 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-3xl flex items-center justify-center text-white text-3xl font-bold shadow-2xl shadow-blue-500/30">
                {data.botInfo.first_name[0]}
              </div>
              <div>
                <h3 className="text-slate-900 dark:text-white text-lg font-bold tracking-tight">{data.botInfo.first_name}</h3>
                <p className="text-blue-500 font-mono text-sm leading-none mt-2">
                  @{data.botInfo.username}
                </p>
                <div className="mt-4 flex items-center gap-2 text-slate-500 text-[10px] font-bold uppercase tracking-widest">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  ID: {data.botInfo.id}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-4 py-4 text-slate-500">
              <Bot className="animate-bounce" />
              <p className="text-sm">Connecting bot instance...</p>
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 p-8 rounded-[2rem] shadow-2xl shadow-purple-500/5">
          <h2 className="text-slate-500 text-[10px] font-bold uppercase tracking-[0.2em] mb-8">Active Workload</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-950 p-5 rounded-2xl border border-slate-800">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Queue Size</p>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold text-white">{data?.queueSize || 0}</span>
                <span className="text-xs text-slate-600 uppercase font-bold tracking-tight">tasks</span>
              </div>
            </div>
            <div className={`bg-slate-100 dark:bg-slate-950 p-5 rounded-2xl border transition-all ${data?.nextTaskIn ? 'border-orange-500/30 bg-orange-500/5' : 'border-slate-200 dark:border-slate-800'}`}>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1 flex items-center gap-1.5">
                <Clock size={10} className={data?.nextTaskIn ? 'text-orange-500' : ''} />
                Next Delay
              </p>
              <div className="flex items-baseline gap-2">
                <span className={`text-3xl font-bold ${data?.nextTaskIn ? 'text-orange-400' : 'text-slate-700'}`}>
                  {data?.nextTaskIn || 0}
                </span>
                <span className="text-xs text-slate-600 uppercase font-bold tracking-tight">seconds</span>
              </div>
            </div>
          </div>
          <div className="mt-6 flex items-center gap-4 p-4 bg-slate-100 dark:bg-slate-950 rounded-2xl border border-slate-200 dark:border-slate-800">
            <Activity className="text-blue-500 shrink-0" size={18} />
            <div className="flex-1 min-w-0">
               <div className="flex justify-between mb-1 text-[10px] font-bold">
                 <span className="text-slate-500 uppercase">Wait Progress</span>
                 <span className="text-blue-500">{data?.nextTaskIn ? Math.round(( (7 - data.nextTaskIn) / 7) * 100) : 0}%</span>
               </div>
               <div className="h-1.5 bg-slate-900 rounded-full overflow-hidden">
                 <motion.div 
                   animate={{ width: data?.nextTaskIn ? `${((7 - data.nextTaskIn) / 7) * 100}%` : '0%' }}
                   className="h-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                 />
               </div>
            </div>
          </div>
        </div>
      </div>

      {/* Setup Checker */}
      <AnimatePresence>
        {!data?.config.hasToken || !data?.config.hasMongo || !data?.adminConfigured ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-rose-500/5 border border-rose-500/20 p-6 rounded-3xl"
          >
            <div className="flex items-center gap-3 mb-6">
              <AlertCircle size={18} className="text-rose-500" />
              <h3 className="text-white font-semibold text-sm">Critical Requirements Missing</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { active: data?.config.hasToken, label: 'Bot Token' },
                { active: data?.config.hasMongo, label: 'Database' },
                { active: data?.adminConfigured, label: 'Admin Access' },
                { active: data?.config.hasTarget, label: 'Target ID' }
              ].map((conf, i) => (
                <div key={i} className={`p-4 rounded-xl border flex flex-col items-center gap-2 text-center transition-colors ${
                  conf.active ? 'bg-emerald-500/5 border-emerald-500/10' : 'bg-rose-500/5 border-rose-500/10'
                }`}>
                  {conf.active ? <CheckCircle2 size={16} className="text-emerald-500" /> : <XCircle size={16} className="text-rose-500" />}
                  <span className={`text-[10px] font-bold uppercase tracking-widest ${conf.active ? 'text-emerald-500/70' : 'text-rose-500/70'}`}>
                    {conf.label}
                  </span>
                </div>
              ))}
            </div>
            <button 
              onClick={() => setActiveTab('config')}
              className="mt-6 w-full py-3 bg-slate-900 border border-rose-500/10 hover:border-rose-500/30 text-rose-500 text-xs font-bold uppercase tracking-widest rounded-xl transition-all"
            >
              Resolve Setup Issues
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="bg-slate-900/40 border border-slate-800 p-8 rounded-[2rem]">
        <h2 className="text-slate-500 text-[10px] font-bold uppercase tracking-[0.2em] mb-6">Real-time Stream</h2>
        <div className="space-y-4">
          <div className="flex items-start gap-4 p-4 bg-slate-950 rounded-2xl border border-slate-800/50">
             <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-500 shirnk-0">
                <Database size={20} />
             </div>
             <div className="flex-1 min-w-0">
               <div className="flex justify-between items-center mb-1">
                 <span className="text-xs font-bold text-slate-900 dark:text-white tracking-tight">Database Connectivity</span>
                 <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold uppercase ${data?.dbStatus === 'Connected' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
                   {data?.dbStatus || 'Searching...'}
                 </span>
               </div>
               <p className="text-[11px] text-slate-500 leading-relaxed">
                 Using MongoDB Atlas for cluster persistence. Rename rules and configuration are synced instantly.
               </p>
             </div>
          </div>
          <div className="flex items-start gap-4 p-4 bg-slate-950 rounded-2xl border border-slate-800/50">
             <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center text-purple-500 shrink-0">
                <Shield size={20} />
             </div>
             <div className="flex-1 min-w-0">
               <div className="flex justify-between items-center mb-1">
                 <span className="text-xs font-bold text-slate-900 dark:text-white tracking-tight">Admin Firewall</span>
                 <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold uppercase ${data?.adminConfigured ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500'}`}>
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
    </div>
  );

  const renderConfig = () => (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-24">
      <div className="bg-slate-900/50 border border-slate-800 p-8 rounded-[2rem]">
        <div className="flex items-center gap-3 mb-8">
          <Settings className="text-blue-500" size={24} />
          <div>
            <h2 className="text-white text-lg font-bold tracking-tight">Primary Configuration</h2>
            <p className="text-xs text-slate-500 tracking-wide">Sync core credentials with MongoDB persistence</p>
          </div>
        </div>

        <form onSubmit={saveSettings} className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="group">
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 group-focus-within:text-blue-500 transition-colors">Admin User ID</label>
                <div className="relative">
                  <UserCheck className="absolute left-4 top-3.5 text-slate-600" size={16} />
                  <input 
                    type="text" 
                    value={adminInput}
                    onChange={(e) => setAdminInput(e.target.value)}
                    placeholder="e.g., 54321678"
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-4 py-3.5 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-4 focus:ring-blue-500/5 transition-all text-white placeholder:text-slate-700"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Userbot String Session</label>
                <div className="relative">
                  <Shield className="absolute left-4 top-3.5 text-slate-600" size={16} />
                  <input 
                    type="password" 
                    value={sessionInput}
                    onChange={(e) => setSessionInput(e.target.value)}
                    placeholder={data?.config.hasSession ? '••••••••••••••••••••' : 'Paste new TGTX/GramJS session string'}
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-4 py-3.5 text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white placeholder:text-slate-700"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Cooldown (seconds)</label>
                <div className="relative">
                  <Clock className="absolute left-4 top-3.5 text-slate-600" size={16} />
                  <input 
                    type="number"
                    value={cooldownInput}
                    onChange={(e) => setCooldownInput(e.target.value)}
                    placeholder="e.g., 15"
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-4 py-3.5 text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white placeholder:text-slate-700"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Target Destination ID</label>
                <div className="relative">
                  <ExternalLink className="absolute left-4 top-3.5 text-slate-600" size={16} />
                  <input 
                    type="text" 
                    value={destInput}
                    onChange={(e) => setDestInput(e.target.value)}
                    placeholder="e.g., -100123456789"
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-4 py-3.5 text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white placeholder:text-slate-700"
                  />
                </div>
              </div>

              <div className="pt-2">
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest">SOCKS5/HTTP Proxy (Optional)</label>
                  <button 
                    onClick={() => setData(data ? {...data, proxy: {ip: '45.12.189.155', port: 1080, socksType: 5}} : null)}
                    className="text-[10px] text-blue-500 hover:text-blue-400 font-bold uppercase transition-colors"
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
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs focus:outline-none focus:border-blue-500/50 text-white"
                  />
                  <input 
                    type="number" 
                    placeholder="Port"
                    value={data?.proxy?.port || ''}
                    onChange={(e) => setData(data ? {...data, proxy: {...(data.proxy || {ip: '', port: 0}), port: parseInt(e.target.value)}} : null)}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs focus:outline-none focus:border-blue-500/50 text-white"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <input 
                    type="text" 
                    placeholder="Username"
                    value={data?.proxy?.user || ''}
                    onChange={(e) => setData(data ? {...data, proxy: {...(data.proxy || {ip: '', port: 0}), user: e.target.value}} : null)}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs focus:outline-none focus:border-blue-500/50 text-white"
                  />
                  <input 
                    type="password" 
                    placeholder="Password"
                    value={data?.proxy?.pass || ''}
                    onChange={(e) => setData(data ? {...data, proxy: {...(data.proxy || {ip: '', port: 0}), pass: e.target.value}} : null)}
                    className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-xs focus:outline-none focus:border-blue-500/50 text-white"
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
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">App API Hash</label>
                  <input 
                    type="text" 
                    value={apiHashInput}
                    onChange={(e) => setApiHashInput(e.target.value)}
                    placeholder="API HASH"
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:border-blue-500/50 transition-all text-white"
                  />
                </div>
              </div>

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
                          ? 'bg-blue-600 border-blue-500 text-white shadow-xl shadow-blue-500/20' 
                          : 'bg-slate-950 border-slate-800 text-slate-500 hover:border-slate-700'
                      }`}
                    >
                      {lib}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-blue-500/5 rounded-2xl p-4 border border-blue-500/10 flex items-start gap-3">
             <AlertCircle size={16} className="text-blue-500 shrink-0 mt-0.5" />
             <p className="text-[11px] text-slate-400 leading-relaxed">
               All settings above are encrypted and saved directly to your MongoDB Atlas collection. They will survive container restarts and server sleep modes.
             </p>
          </div>

          <button 
            type="submit"
            disabled={saving || !data?.config.hasMongo}
            className={`w-full py-4 rounded-[1.25rem] font-bold text-xs uppercase tracking-[0.2em] transition-all flex items-center justify-center gap-2 transform active:scale-[0.98] ${
              saving 
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed' 
                : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:scale-[1.02] text-white shadow-2xl shadow-blue-500/20'
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
       <div className="bg-slate-900/50 border border-slate-800 p-8 rounded-[2rem]">
          <div className="flex items-center gap-3 mb-8">
            <div className="p-2.5 bg-blue-500/10 rounded-2xl text-blue-500">
              <Tag size={24} />
            </div>
            <div>
              <h2 className="text-white text-lg font-bold tracking-tight">Smart Renaming rules</h2>
              <p className="text-xs text-slate-500 tracking-wide">Automatic keyword replacement in captions & filenames</p>
            </div>
          </div>

          <div className="bg-slate-950/40 p-6 rounded-[2rem] border border-slate-800/80 mb-8">
            <div className="grid sm:grid-cols-2 gap-6">
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-slate-500 mb-3 font-bold">Search For</label>
                <input 
                  type="text"
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  placeholder="e.g., @AdChannel_Bot"
                  className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500/50 text-slate-200 placeholder:text-slate-800 shadow-inner"
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
                    className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500/50 text-slate-200 placeholder:text-slate-800 shadow-inner"
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
                    className="p-3 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl flex items-center justify-center transition-all shadow-xl shadow-blue-500/20"
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
               <div className="text-center py-16 border-2 border-dashed border-slate-800/50 rounded-[2.5rem] bg-slate-950/20">
                 <Tag className="mx-auto text-slate-800 mb-4" size={48} />
                 <p className="text-sm font-bold text-slate-700 uppercase tracking-widest">No Active Match Patterns</p>
               </div>
             ) : (
               <div className="grid gap-3 max-h-[40vh] overflow-y-auto pr-2 custom-scrollbar">
                  {renameRules.map((rule, idx) => (
                    <motion.div 
                      key={idx} 
                      initial={{ opacity: 0, x: -10 }} 
                      animate={{ opacity: 1, x: 0 }}
                      className="group flex items-center gap-4 p-5 bg-slate-950 border border-slate-800/60 rounded-[1.5rem] hover:border-blue-500/20 transition-all"
                    >
                      <div className="flex-1 min-w-0 flex items-center gap-3">
                         <div className="px-3 py-1 bg-rose-500/5 border border-rose-500/10 rounded-lg">
                            <span className="text-[11px] font-mono font-bold text-rose-400">{rule.keyword}</span>
                         </div>
                         <ArrowRight className="text-slate-700" size={14} />
                         <div className="px-3 py-1 bg-emerald-500/5 border border-emerald-500/10 rounded-lg">
                            <span className="text-[11px] font-mono font-bold text-emerald-400 truncate max-w-[120px] block">
                              {rule.replaceWith || '(blank)'}
                            </span>
                         </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setRenameRules(renameRules.filter((_, rIdx) => rIdx !== idx))}
                        className="p-2.5 text-slate-700 hover:text-rose-500 hover:bg-rose-500/5 rounded-xl transition-all opacity-0 group-hover:opacity-100"
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
              className="mt-12 w-full py-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs uppercase tracking-[0.2rem] rounded-2xl transition-all shadow-2xl shadow-emerald-500/20"
            >
              Sync Rules to Cloud
            </button>
          )}
       </div>
    </div>
  );

  const renderMirror = () => {
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
            userId: data?.adminId || '6431447408' // Fallback to a known admin ID
          })
        });
        if (!response.ok) throw new Error('Failed to set path');
        alert('Path successfully updated!');
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Error setting path');
      } finally {
        setSettingPath(false);
      }
    };

    return (
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-24">
        <div className="bg-slate-900/50 border border-slate-800 p-8 rounded-[2rem]">
          <h2 className="text-white text-lg font-bold tracking-tight mb-8">Mirroring Destination</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Destination Chat ID</label>
              <input 
                type="text" 
                value={pathChatId}
                onChange={(e) => setPathChatId(e.target.value)}
                placeholder="e.g., -100XXXXXXX"
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:border-blue-500/50 text-white"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Topic ID (Optional)</label>
              <input 
                type="text" 
                value={pathTopicId}
                onChange={(e) => setPathTopicId(e.target.value)}
                placeholder="e.g., 48"
                className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3.5 text-sm focus:outline-none focus:border-blue-500/50 text-white"
              />
            </div>
            <button 
              onClick={handleSetPath}
              disabled={settingPath}
              className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs uppercase tracking-[0.2rem] rounded-2xl transition-all"
            >
              {settingPath ? 'Saving...' : 'Set Destination Path'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderSystem = () => (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-24">
      <div className="bg-slate-900/50 border border-slate-800 p-8 rounded-[2rem]">
        <h2 className="text-slate-500 text-[10px] font-bold uppercase tracking-[0.2em] mb-8 italic">Dev Studio Roadmap</h2>
        <div className="grid gap-4">
          {[
            { 
              title: 'Media Saver', 
              desc: 'Premium content decryption engine for restricted groups.', 
              status: 'stable',
              icon: Shield
            },
            { 
              title: 'Parallel Mirroring', 
              desc: 'High-speed data transfer workers for massive archives.', 
              status: 'active',
               icon: Layers
            },
            { 
              title: 'Command SDK', 
              desc: 'Modular inline-button framework for sequential bots.', 
              status: 'v3.2',
               icon: Bot
            },
            { 
              title: 'Anti-Flood Guard', 
              desc: 'Intelligent delay buffers for Telegram safety.', 
              status: 'running',
               icon: Activity
            }
          ].map((f, i) => (
            <div key={i} className="group p-6 bg-slate-950 border border-slate-800/80 rounded-2xl hover:border-blue-500/40 transition-all">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-500 group-hover:text-blue-500 transition-colors">
                   <f.icon size={22} />
                </div>
                <div className="flex-1">
                  <div className="flex justify-between items-center mb-1">
                    <h4 className="text-white font-bold text-sm">{f.title}</h4>
                    <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded bg-blue-500/10 text-blue-500">{f.status}</span>
                  </div>
                  <p className="text-[11px] text-slate-500 leading-normal">{f.desc}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (loading && !data) return (
    <div className="min-h-screen bg-[#08090d] flex items-center justify-center">
      <motion.div 
        animate={{ scale: [1, 1.1, 1], opacity: [0.5, 1, 0.5] }}
        transition={{ repeat: Infinity, duration: 2 }}
        className="text-blue-500"
      >
        <Bot size={64} />
      </motion.div>
    </div>
  );

  return (
    <div className={isDarkMode ? 'dark' : ''}>
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 font-sans selection:bg-blue-500/30 pb-20">
        <div className="max-w-4xl mx-auto px-6 py-10">
          {/* Header */}
          <header className="mb-10 flex items-center justify-between sticky top-0 bg-slate-50/80 dark:bg-slate-950/80 backdrop-blur-xl z-10 py-4 -mx-6 px-6">
            <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}>
              <h1 className="text-xl font-black text-slate-900 dark:text-white tracking-tighter flex items-center gap-2.5">
                <div className="p-2 bg-sky-500 rounded-lg">
                   <Bot className="text-white" size={16} />
                </div>
                STUDIO <span className="text-sky-500">V3</span>
              </h1>
            </motion.div>
            <div className="flex gap-2">
              <button onClick={() => setIsDarkMode(!isDarkMode)} className="p-2 rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                {isDarkMode ? '🌙' : '☀️'}
              </button>
              <StatusBadge label={data?.status || 'Unknown'} active={data?.status === 'Running'} icon={Activity} />
              <StatusBadge label="Atlas DB" active={data?.dbStatus === 'Connected'} icon={Database} />
            </div>
          </header>

          <main>
            {activeTab === 'dashboard' && renderDashboard()}
            {activeTab === 'config' && renderConfig()}
            {activeTab === 'rules' && renderRules()}
            {activeTab === 'mirror' && renderMirror()}
            {activeTab === 'system' && renderSystem()}
          </main>
        </div>

        {/* Persistent Bottom Nav */}
        <nav className="fixed bottom-0 inset-x-0 bg-slate-200 dark:bg-slate-950/90 backdrop-blur-2xl border-t border-slate-300 dark:border-slate-800/80 px-6 py-1 z-50 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
          <div className="max-w-md mx-auto flex items-center justify-between">
            <NavButton tab="dashboard" icon={Home} label="Status" />
            <NavButton tab="config" icon={Settings} label="Config" />
            <NavButton tab="rules" icon={FileEdit} label="Rules" />
            <NavButton tab="mirror" icon={Layers} label="Mirror" />
            <NavButton tab="system" icon={Bot} label="System" />
          </div>
        </nav>
      </div>
    </div>
  );
}
