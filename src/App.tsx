import React, { useEffect, useState } from 'react';
import { Bot, Shield, AlertCircle, CheckCircle2, Settings, ExternalLink, Database, UserCheck, XCircle, Plus, Trash2, Tag } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { BotStatus } from './types';

export default function App() {
  const [data, setData] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    const interval = setInterval(fetchData, 5000);
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
    }
  }, [data]);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
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
          renameRules: renameRules
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
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border transition-all ${
      active ? 'bg-blue-500/10 border-blue-500/30 text-blue-400' : 'bg-red-500/10 border-red-500/30 text-red-400'
    }`}>
      <Icon size={14} />
      <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#0f1115] text-slate-200 font-sans selection:bg-blue-500/30">
      <div className="max-w-4xl mx-auto px-6 py-12">
        {/* Header */}
        <header className="mb-12 flex items-center justify-between">
          <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}>
            <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
              <Bot className="text-blue-500 w-10 h-10" />
              Restricted Bot Studio
            </h1>
            <p className="text-slate-400 mt-2 text-sm max-w-md">
              Securely manage restricted content downloads and group mirroring from one central dashboard.
            </p>
          </motion.div>
          <div className="flex flex-col gap-2 items-end">
            <StatusBadge label={data?.status || 'Offline'} active={data?.status === 'Running'} icon={Bot} />
            <StatusBadge label={data?.dbStatus === 'Connected' ? 'Database UI' : 'DB Offline'} active={data?.dbStatus === 'Connected'} icon={Database} />
          </div>
        </header>

        <main className="grid gap-6">
          <AnimatePresence>
            {!data?.config.hasToken || !data?.config.hasMongo || !data?.adminConfigured ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-slate-900 border border-slate-800 p-6 rounded-3xl"
              >
                <div className="flex items-center gap-3 mb-6">
                  <Settings size={20} className="text-blue-500" />
                  <h3 className="text-white font-semibold">Required Setup</h3>
                </div>
                <div className="grid sm:grid-cols-3 gap-4">
                  {[
                    { key: 'TELEGRAM_BOT_TOKEN', active: data?.config.hasToken, label: 'Bot Token' },
                    { key: 'MONGODB_URI', active: data?.config.hasMongo, label: 'Database' },
                    { key: 'ADMIN_ID', active: data?.adminConfigured, label: 'Admin Access' },
                    { key: 'DEST_CHAT_ID', active: data?.config.hasTarget, label: 'Target Group' }
                  ].map((conf) => (
                    <div key={conf.key} className={`p-4 rounded-2xl border flex flex-col gap-2 ${
                      conf.active ? 'bg-green-500/5 border-green-500/10' : 'bg-red-500/5 border-red-500/10'
                    }`}>
                      <div className="flex items-center justify-between">
                        <span className={`text-[10px] font-bold uppercase tracking-widest ${conf.active ? 'text-green-500' : 'text-red-500'}`}>
                          {conf.label}
                        </span>
                        {conf.active ? <CheckCircle2 size={14} className="text-green-500" /> : <XCircle size={14} className="text-red-500" />}
                      </div>
                      <code className="text-[11px] font-mono text-slate-500">{conf.key}</code>
                    </div>
                  ))}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div className="grid md:grid-cols-2 gap-6">
            {/* Bot Identity Card */}
            <motion.div 
              whileHover={{ scale: 1.01 }}
              className="bg-slate-900/50 border border-slate-800 p-8 rounded-3xl relative overflow-hidden group"
            >
              <div className="absolute top-0 right-0 p-4 opacity-5 group-hover:opacity-10 transition-opacity">
                <Bot size={120} />
              </div>
              <h2 className="text-slate-400 text-[10px] font-bold uppercase tracking-[0.2em] mb-8">Bot Instance</h2>
              {data?.botInfo ? (
                <div className="flex items-center gap-5">
                  <div className="w-20 h-20 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-3xl flex items-center justify-center text-white text-3xl font-bold shadow-2xl shadow-blue-500/20 ring-4 ring-slate-800/50">
                    {data.botInfo.first_name[0]}
                  </div>
                  <div>
                    <h3 className="text-white text-xl font-bold tracking-tight">{data.botInfo.first_name}</h3>
                    <p className="text-blue-500 font-mono text-sm leading-none mt-2">
                      @{data.botInfo.username}
                    </p>
                    <div className="mt-4 flex items-center gap-2 text-slate-500 text-xs">
                      <span className="w-1 h-1 rounded-full bg-green-500" />
                      ID: {data.botInfo.id}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4 py-8">
                  <div className="w-12 h-12 bg-slate-800 rounded-full flex items-center justify-center animate-pulse">
                    <Bot size={24} className="text-slate-600" />
                  </div>
                  <p className="text-slate-500 text-sm font-medium">Connecting to Telegram...</p>
                </div>
              )}
            </motion.div>

            {/* Security Config Card */}
            <div className="bg-slate-900/50 border border-slate-800 p-8 rounded-3xl">
              <h2 className="text-slate-400 text-[10px] font-bold uppercase tracking-[0.2em] mb-8">Security & Auth</h2>
              <div className="space-y-4">
                <div className="flex items-center gap-4 p-4 bg-slate-800/30 rounded-2xl border border-slate-700/30">
                  <div className={`p-2.5 rounded-xl ${data?.adminConfigured ? 'bg-blue-500/10 text-blue-500' : 'bg-red-500/10 text-red-500'}`}>
                    <UserCheck size={20} />
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Admin Guard</p>
                    <p className="text-white font-medium text-sm">{data?.adminConfigured ? 'Strict Mode Enabled' : 'Permissive (Not Recommended)'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 p-4 bg-slate-800/30 rounded-2xl border border-slate-700/30">
                  <div className={`p-2.5 rounded-xl ${data?.dbStatus === 'Connected' ? 'bg-blue-500/10 text-blue-500' : 'bg-red-500/10 text-red-500'}`}>
                    <Database size={20} />
                  </div>
                  <div>
                    <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Persistence</p>
                    <p className="text-white font-medium text-sm">{data?.dbStatus === 'Connected' ? 'MongoDB Cluster Active' : 'Offline'}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Persistent Settings Form */}
          <div className="bg-slate-900/50 border border-slate-800 p-8 rounded-3xl">
            <h2 className="text-slate-400 text-[10px] font-bold uppercase tracking-[0.2em] mb-8">Management Portal (MongoDB Persistence)</h2>
            <form onSubmit={saveSettings} className="space-y-6">
              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Admin User ID</label>
                    <input 
                      type="text" 
                      value={adminInput}
                      onChange={(e) => setAdminInput(e.target.value)}
                      placeholder="e.g., 54321678"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-green-500/50 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Userbot String Session</label>
                    <input 
                      type="password" 
                      value={sessionInput}
                      onChange={(e) => setSessionInput(e.target.value)}
                      placeholder={data?.config.hasSession ? '••••••••••••' : 'Enter new session string'}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-green-500/50 transition-colors"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Destination Chat ID</label>
                    <input 
                      type="text" 
                      value={destInput}
                      onChange={(e) => setDestInput(e.target.value)}
                      placeholder="e.g., -100123456789"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-green-500/50 transition-colors"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">API ID</label>
                      <input 
                        type="text" 
                        value={apiIdInput}
                        onChange={(e) => setApiIdInput(e.target.value)}
                        placeholder="API ID"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-green-500/50 transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">API HASH</label>
                      <input 
                        type="text" 
                        value={apiHashInput}
                        onChange={(e) => setApiHashInput(e.target.value)}
                        placeholder="API HASH"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-green-500/50 transition-colors"
                      />
                    </div>
                  </div>
                  <div className="pt-2">
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Download Engine (Library Preference)</label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {['GramJS', 'Telethon', 'Pyrogram', 'Hydrogram'].map((lib) => (
                        <button
                          key={lib}
                          type="button"
                          onClick={() => setLibSelection(lib)}
                          className={`py-2 px-3 rounded-xl text-[10px] font-bold border transition-all ${
                            libSelection === lib 
                              ? 'bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-500/20' 
                              : 'bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-700'
                          }`}
                        >
                          {lib}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex flex-col justify-between gap-4">
                  <div className="space-y-4">
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Configuration Info</label>
                    <p className="text-xs text-slate-400 leading-relaxed bg-slate-950/30 p-4 rounded-xl border border-slate-800">
                      Configure credentials and the master target location above. Expand functionality using the real-time keyword replacement editor below. Perfect for cleaning up advertising credits, channel handlers, or watermarks.
                    </p>
                  </div>
                  <div className="space-y-3">
                    <p className="text-[10px] text-slate-500 leading-relaxed ring-1 ring-slate-800 p-3 rounded-xl">
                      ⚠️ Note: Settings saved here are stored in your <strong>MongoDB database</strong> and will persist across bot restarts and deployments.
                    </p>
                    <button 
                      type="submit"
                      disabled={saving || !data?.config.hasMongo}
                      className={`w-full py-3 rounded-xl font-bold text-xs uppercase tracking-widest transition-all ${
                        saving 
                          ? 'bg-slate-800 text-slate-500 cursor-not-allowed' 
                          : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/20 active:scale-95'
                      }`}
                    >
                      {saving ? 'Syncing...' : 'Save Configuration & Rules'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Keyword Rename Rules Segment */}
              <div className="border-t border-slate-800/85 pt-6 space-y-4">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Tag className="text-blue-500 w-4 h-4" />
                    Filename & Caption Rename Rules
                  </h3>
                  <p className="text-xs text-slate-500 mt-1">
                    Define custom replacement rules. If a keyword is found in the caption or filename of downloaded content, it will be automatically replaced before uploading.
                  </p>
                </div>

                {/* Add new rule form inline */}
                <div className="grid sm:grid-cols-3 gap-3 bg-slate-950/40 p-4 rounded-2xl border border-slate-800/80">
                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1.5 font-semibold">Keyword to search</label>
                    <input 
                      type="text"
                      value={newKeyword}
                      onChange={(e) => setNewKeyword(e.target.value)}
                      placeholder="e.g., @AdsChannel"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-blue-500/50 text-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1.5 font-semibold">Replace with</label>
                    <input 
                      type="text"
                      value={newReplaceWith}
                      onChange={(e) => setNewReplaceWith(e.target.value)}
                      placeholder="e.g., @MyChannel (or empty to remove)"
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-blue-500/50 text-slate-200"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={() => {
                        const word = newKeyword.trim();
                        if (!word) {
                          alert('Please enter a keyword.');
                          return;
                        }
                        if (renameRules.some(r => r.keyword.toLowerCase() === word.toLowerCase())) {
                          alert('Rename rule for this keyword already exists. Delete the old one first.');
                          return;
                        }
                        setRenameRules([...renameRules, { keyword: word, replaceWith: newReplaceWith }]);
                        setNewKeyword('');
                        setNewReplaceWith('');
                      }}
                      className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <Plus size={14} /> Add Pattern Rule
                    </button>
                  </div>
                </div>

                {/* List current rules */}
                <div className="space-y-2">
                  <span className="block text-[10px] uppercase tracking-widest text-slate-500 font-bold">Active Rename Rules ({renameRules.length})</span>
                  {renameRules.length === 0 ? (
                    <div className="text-center py-6 border border-dashed border-slate-800/80 rounded-2xl text-xs text-slate-600">
                      No custom replacement rules defined yet. Matches will default to original names/captions.
                    </div>
                  ) : (
                    <div className="grid sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                      {renameRules.map((rule, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3 bg-slate-950 border border-slate-800/60 rounded-xl text-slate-300">
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span className="text-xs font-semibold text-slate-400 truncate">Match: <code className="bg-slate-900 px-1 py-0.5 rounded text-red-400 font-mono text-[11px] font-bold">{rule.keyword}</code></span>
                            <span className="text-xs text-slate-500 truncate">Replace: <code className="bg-slate-900 px-1 py-0.5 rounded text-green-400 font-mono text-[11px] font-bold">{rule.replaceWith || '(Completely Remove)'}</code></span>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setRenameRules(renameRules.filter((_, rIdx) => rIdx !== idx));
                            }}
                            className="p-1 px-2 text-slate-500 hover:text-red-400 hover:bg-red-500/5 rounded-lg transition-colors border border-transparent hover:border-red-500/10"
                            title="Remove Rule"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </form>
          </div>

          {/* Analysis & Roadmap */}
          <div className="bg-slate-900/50 border border-slate-800 p-8 rounded-3xl">
            <h2 className="text-slate-400 text-[10px] font-bold uppercase tracking-[0.2em] mb-8">Repository Feature Analysis (devgaganin/v3)</h2>
            <div className="grid sm:grid-cols-2 gap-6">
              {[
                { 
                  title: 'Restricted Media Saver', 
                  desc: 'Bypasses Content Copy restrictions in private/protected channels using Userbot string sessions.', 
                  status: 'Implementing Core' 
                },
                { 
                  title: 'Topic Mirroring', 
                  desc: 'Clones content while maintaining Telegram Topic/Folder structures. New uploads are mirrored in real-time.', 
                  status: 'Active' 
                },
                { 
                  title: 'Interactive Command UI', 
                  desc: 'Uses Inline Buttons and Force Reply for clean sequential steps in Batch mode.', 
                  status: 'Active' 
                },
                { 
                  title: 'Admin Verification', 
                  desc: 'Commands are strictly locked to the owner to prevent bot abuse and session theft.', 
                  status: 'Verified' 
                }
              ].map((f, i) => (
                <div key={i} className="group p-5 bg-slate-800/20 border border-slate-700/20 rounded-2xl flex flex-col gap-3 hover:border-blue-500/30 transition-colors">
                  <div className="flex items-center justify-between">
                    <h4 className="text-white font-semibold text-sm group-hover:text-blue-400 transition-colors">{f.title}</h4>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-blue-500/10 text-blue-500 border border-blue-500/20">
                      {f.status}
                    </span>
                  </div>
                  <p className="text-slate-500 text-xs leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </main>

        <footer className="mt-12 text-center text-slate-600 text-xs flex items-center justify-center gap-4">
          <span>v1.2.0-Alpha</span>
          <span className="w-1 h-1 rounded-full bg-slate-800" />
          <span>MongoDB Atlas Ready</span>
          <span className="w-1 h-1 rounded-full bg-slate-800" />
          <span>Bot Father Verified</span>
        </footer>
      </div>
    </div>
  );
}
