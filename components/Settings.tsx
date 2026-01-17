import React from 'react';
import { useReadallStore } from '../store/useReadallStore';
import { AppSettings, DEFAULT_SETTINGS } from '../types';

export const Settings: React.FC = () => {
  const { settings, updateSettings, setView, previousView } = useReadallStore();

  const handleChange = (key: keyof AppSettings, value: any) => {
    updateSettings({ [key]: value });
  };

  const fontOptions = [
    { id: 'sans', label: 'Sans' },
    { id: 'serif', label: 'Serif' },
    { id: 'mono', label: 'Mono' },
    { id: 'opendyslexic', label: 'OpenDyslexic' },
    { id: 'lexend', label: 'Lexend' },
  ] as const;

  return (
    <div className="fixed inset-0 bg-gray-900 text-gray-100 p-8 overflow-y-auto z-50">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-8 border-b border-gray-800 pb-4">
            <h2 className="text-3xl font-bold">Settings</h2>
            <button 
                onClick={() => setView(previousView || 'library')} 
                className="text-gray-400 hover:text-white flex items-center gap-2"
            >
                <span className="text-xl">✕</span> Close
            </button>
        </div>

        <div className="space-y-8">
            {/* Speed */}
            <section>
                <h3 className="text-lg font-semibold mb-4 text-blue-400">Reading Speed</h3>
                <div className="flex items-center gap-4">
                    <input 
                        type="range" 
                        min="100" 
                        max="1000" 
                        step="10"
                        value={settings.wpm} 
                        onChange={(e) => handleChange('wpm', Number(e.target.value))}
                        className="w-full accent-blue-500 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                    />
                    <span className="font-mono text-xl w-24 text-right">{settings.wpm}</span>
                </div>
            </section>

            {/* AI Configuration */}
            <section className="bg-gray-800 p-6 rounded-xl border border-gray-700">
                <h3 className="text-lg font-semibold mb-2 text-purple-400">AI Enhancement</h3>
                <p className="text-sm text-gray-400 mb-4">
                    Enable Semantic Chunking to group words into meaningful phrases using OpenRouter (gpt-oss-120b).
                </p>
                
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">OpenRouter API Key</label>
                        <input 
                            type="password"
                            value={settings.apiKey}
                            onChange={(e) => handleChange('apiKey', e.target.value)}
                            placeholder="sk-or-..."
                            className="w-full bg-gray-900 border border-gray-600 rounded p-2 text-sm focus:border-purple-500 outline-none"
                        />
                        <p className="text-xs text-gray-500 mt-1">Key is stored locally in your browser.</p>
                    </div>

                    <div className="flex items-center gap-2">
                        <label className="text-sm">Chunking Mode:</label>
                        <select 
                            value={settings.chunkingMode}
                            onChange={(e) => handleChange('chunkingMode', e.target.value as any)}
                            className="bg-gray-900 border border-gray-600 rounded p-1 text-sm"
                        >
                            <option value="algorithmic">Fast (Algorithmic)</option>
                            <option value="ai">Smart (AI / GPU)</option>
                        </select>
                    </div>
                </div>
            </section>

            {/* Visuals */}
            <section>
                <h3 className="text-lg font-semibold mb-4 text-green-400">Visuals</h3>
                
                <div className="mb-6">
                    <label className="block text-sm mb-3 text-gray-400">Font Family</label>
                    <div className="flex flex-wrap gap-2">
                        {fontOptions.map((opt) => (
                            <button
                                key={opt.id}
                                onClick={() => handleChange('fontFamily', opt.id)}
                                className={`px-4 py-2 rounded-lg border text-sm transition-all ${
                                    settings.fontFamily === opt.id 
                                    ? 'border-green-500 bg-green-500/20 text-white shadow-[0_0_10px_rgba(34,197,94,0.2)]' 
                                    : 'border-gray-700 hover:border-gray-500 text-gray-300'
                                }`}
                            >
                                <span className={
                                    opt.id === 'serif' ? 'font-serif' : 
                                    opt.id === 'mono' ? 'font-mono' : 
                                    opt.id === 'opendyslexic' ? 'font-opendyslexic' :
                                    opt.id === 'lexend' ? 'font-lexend' : 'font-sans'
                                }>
                                    {opt.label}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm mb-2 text-gray-400">Theme</label>
                        <div className="flex flex-wrap gap-2">
                            {(['oled', 'sepia', 'high-contrast'] as const).map(t => (
                                <button
                                    key={t}
                                    onClick={() => handleChange('theme', t)}
                                    className={`px-3 py-1 rounded border capitalize text-sm ${settings.theme === t ? 'border-blue-500 bg-blue-500/20' : 'border-gray-600'}`}
                                >
                                    {t}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                         <label className="block text-sm mb-2 text-gray-400">Reticle</label>
                         <button 
                            onClick={() => handleChange('showReticle', !settings.showReticle)}
                            className={`px-3 py-1 rounded border text-sm ${settings.showReticle ? 'bg-blue-500/20 border-blue-500' : 'border-gray-600'}`}
                         >
                            {settings.showReticle ? 'Shown' : 'Hidden'}
                         </button>
                    </div>
                </div>
            </section>
            
            <section className="pt-8 border-t border-gray-800">
                <button 
                    onClick={() => {
                        if(confirm('Reset all settings?')) updateSettings(DEFAULT_SETTINGS);
                    }}
                    className="text-red-400 text-sm hover:underline"
                >
                    Reset to Defaults
                </button>
            </section>
        </div>
      </div>
    </div>
  );
};