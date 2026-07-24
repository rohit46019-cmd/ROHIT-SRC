import React from 'react';

interface CompactCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}

export function CompactCard({ title, subtitle, children, icon, className = '' }: CompactCardProps) {
  return (
    <div className={`glass-panel p-3 rounded-xl flex flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon && <div className="text-sky-500">{icon}</div>}
          <div className="flex flex-col">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500 leading-none">{title}</span>
            {subtitle && <span className="text-[9px] text-slate-400 mt-0.5">{subtitle}</span>}
          </div>
        </div>
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

export function SectionHeader({ title, subtitle, icon }: { title: string, subtitle?: string, icon?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      {icon && <div className="p-1.5 bg-sky-500/10 rounded-lg text-sky-500">{icon}</div>}
      <div>
        <h2 className="text-sm font-black tracking-tight text-slate-900 dark:text-white uppercase font-display">{title}</h2>
        {subtitle && <p className="text-[10px] text-slate-500 font-medium">{subtitle}</p>}
      </div>
    </div>
  );
}
