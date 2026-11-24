import React from 'react';
import { Download } from 'lucide-react';

interface HeaderProps {
  activeSection: 'workspace' | 'preservation' | 'engine';
  selectedCount: number;
  onNavigate: (section: 'workspace' | 'preservation' | 'engine') => void;
  onOpenExport: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeSection,
  selectedCount,
  onNavigate,
  onOpenExport,
}) => {
  return (
    <header className="bg-[#0f1522] border-b border-slate-800 sticky top-0 z-30">
      <div className="max-w-[1400px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Single-line Brand Wordmark */}
        <a
          href="#workspace"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('workspace');
          }}
          className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-blue-500 rounded"
        >
          GainBench
        </a>

        {/* Zone 2: Concise single-line navigation links */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-400">
          <button
            type="button"
            onClick={() => onNavigate('workspace')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'workspace'
                ? 'border-blue-500 text-white'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Batch Queue
          </button>
          <button
            type="button"
            onClick={() => onNavigate('engine')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'engine'
                ? 'border-blue-500 text-white'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            Audio Engine
          </button>
          <button
            type="button"
            onClick={() => onNavigate('preservation')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeSection === 'preservation'
                ? 'border-blue-500 text-white'
                : 'border-transparent hover:text-slate-200'
            }`}
          >
            ID3 Integrity
          </button>
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            disabled={selectedCount === 0}
            onClick={onOpenExport}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>Apply &amp; Save ({selectedCount})</span>
          </button>
        </div>
      </div>
    </header>
  );
};
