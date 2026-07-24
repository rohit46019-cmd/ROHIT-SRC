import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Tag, ArrowRight } from 'lucide-react';

export default function MirrorPathManager() {
  const [paths, setPaths] = useState<any[]>([]);
  const [newChatId, setNewChatId] = useState('');
  const [newTopicId, setNewTopicId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newTopicName, setNewTopicName] = useState('');

  const fetchPaths = async () => {
    try {
      const res = await fetch('/api/settings/mirror-paths');
      if (res.ok) setPaths(await res.json());
    } catch (e) {}
  };

  useEffect(() => {
    fetchPaths();
  }, []);

  const addPath = async () => {
    if (!newChatId) return;
    try {
      const res = await fetch('/api/mirror/add-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          chatId: newChatId, 
          topicId: newTopicId, 
          groupTitle: newGroupName, 
          topicName: newTopicName 
        })
      });
      if (res.ok) {
        fetchPaths();
        setNewChatId('');
        setNewTopicId('');
        setNewGroupName('');
        setNewTopicName('');
      }
    } catch (e) {}
  };

  const deletePath = async (id: string) => {
    try {
      await fetch('/api/mirror/delete-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      fetchPaths();
    } catch (e) {}
  };

  return (
    <div className="space-y-4">
      <div className="glass-panel p-3 rounded-xl space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <input 
            type="text" 
            placeholder="Chat ID (e.g. -100...)" 
            value={newChatId}
            onChange={e => setNewChatId(e.target.value)}
            className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1.5 text-[11px] focus:outline-none focus:border-sky-500/50"
          />
          <input 
            type="text" 
            placeholder="Topic ID (optional)" 
            value={newTopicId}
            onChange={e => setNewTopicId(e.target.value)}
            className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1.5 text-[11px] focus:outline-none focus:border-sky-500/50"
          />
          <input 
            type="text" 
            placeholder="Group Name" 
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1.5 text-[11px] focus:outline-none focus:border-sky-500/50"
          />
          <input 
            type="text" 
            placeholder="Topic Name" 
            value={newTopicName}
            onChange={e => setNewTopicName(e.target.value)}
            className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg px-2 py-1.5 text-[11px] focus:outline-none focus:border-sky-500/50"
          />
        </div>
        <button onClick={addPath} className="btn-primary w-full py-1.5 flex items-center justify-center gap-2">
          <Plus size={12} /> Add Destination Path
        </button>
      </div>

      <div className="space-y-2">
        {paths.map((path, i) => (
          <div key={i} className="glass-panel p-3 rounded-xl flex items-center justify-between group">
            <div className="flex items-center gap-3">
              <div className="p-1.5 bg-sky-500/10 rounded-lg text-sky-500">
                <Tag size={12} />
              </div>
              <div className="flex flex-col">
                <span className="text-[11px] font-bold text-slate-700 dark:text-slate-200">{path.groupTitle || 'Unknown Group'}</span>
                <span className="text-[9px] text-slate-400 font-mono">{path.chatId} {path.topicId ? `[Topic: ${path.topicId}]` : ''}</span>
              </div>
            </div>
            <button onClick={() => deletePath(path.id || path._id)} className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition-all opacity-0 group-hover:opacity-100">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
