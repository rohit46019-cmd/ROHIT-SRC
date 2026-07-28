import React from 'react';
import { Home, Zap, Layers, Settings, Shield } from 'lucide-react';
import { motion } from 'motion/react';

type Tab = 'home' | 'control' | 'mirror' | 'config' | 'system';

interface BottomNavProps {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
}

const BottomNav: React.FC<BottomNavProps> = ({ activeTab, setActiveTab }) => {
  const navItems: { id: Tab; label: string; icon: any }[] = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'control', label: 'Control', icon: Zap },
    { id: 'mirror', label: 'Mirror', icon: Layers },
    { id: 'config', label: 'Settings', icon: Settings },
    { id: 'system', label: 'System', icon: Shield },
  ];

  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-white/80 dark:bg-[#0b1224]/80 backdrop-blur-lg border-t border-slate-200 dark:border-slate-900 px-6 py-3 z-50 flex justify-between items-center safe-area-bottom">
      {navItems.map((item) => {
        const Icon = item.icon;
        const isActive = activeTab === item.id;
        
        return (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className="flex flex-col items-center gap-1 relative"
          >
            <div className={`p-1.5 rounded-xl transition-all duration-300 ${
              isActive 
                ? 'bg-sky-500 text-white shadow-lg shadow-sky-500/20 scale-110' 
                : 'text-slate-400'
            }`}>
              <Icon size={18} />
            </div>
            <span className={`text-[9px] font-bold uppercase tracking-widest transition-all duration-300 ${
              isActive ? 'text-sky-500 opacity-100' : 'text-slate-500 opacity-0'
            }`}>
              {item.label}
            </span>
            {isActive && (
              <motion.div
                layoutId="activeTab"
                className="absolute -top-1 w-1 h-1 bg-sky-500 rounded-full"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
};

export default BottomNav;
