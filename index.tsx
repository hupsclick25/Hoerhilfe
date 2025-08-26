import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

const EQ_FREQUENCIES = [125, 250, 500, 1000, 2000, 4000];

interface EQSettings {
  [key: number]: number;
}

interface Profile {
  name: string;
  preAmp: number;
  volume: number;
  eq: EQSettings;
  balance: number;
}

const DEFAULT_EQ: EQSettings = { 125: 0, 250: 0, 500: 0, 1000: 0, 2000: 0, 4000: 0 };
const DEFAULT_VOLUME = 100;
const DEFAULT_PRE_AMP = 100;
const DEFAULT_BALANCE = 0;

const PREDEFINED_PROFILES: Profile[] = [
  { name: 'Gespräch', preAmp: 130, volume: 120, eq: { 125: -2, 250: -4, 500: 0, 1000: 6, 2000: 5, 4000: 3 }, balance: 0 },
  { name: 'Fernseher', preAmp: 120, volume: 110, eq: { 125: 4, 250: 2, 500: 1, 1000: 5, 2000: 4, 4000: 3 }, balance: 0 },
  { name: 'Straße', preAmp: 100, volume: 130, eq: { 125: -12, 250: -10, 500: -5, 1000: 0, 2000: 3, 4000: 5 }, balance: 0 },
];


const useLocalStorage = <T,>(key: string, initialValue: T): [T, React.Dispatch<React.SetStateAction<T>>] => {
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  const setValue = (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.error(error);
    }
  };

  return [storedValue, setValue];
};

const Modal: React.FC<{ children: React.ReactNode; show: boolean; }> = ({ children, show }) => {
  if (!show) return null;
  return (
    <div className="modal-overlay" aria-modal="true" role="dialog">
      <div className="modal-content">
        {children}
      </div>
    </div>
  );
};

const App: React.FC = () => {
    const [theme, setTheme] = useLocalStorage<'light' | 'dark'>('theme', 'light');
    const [isStarted, setIsStarted] = useState(false);
    const [preAmp, setPreAmp] = useState(DEFAULT_PRE_AMP);
    const [volume, setVolume] = useState(DEFAULT_VOLUME);
    const [eqValues, setEqValues] = useState<EQSettings>(DEFAULT_EQ);
    const [balance, setBalance] = useState(DEFAULT_BALANCE);
    const [customProfiles, setCustomProfiles] = useLocalStorage<Profile[]>('customProfiles', []);
    const [selectedProfile, setSelectedProfile] = useState<string>('default');

    const [showInitialWarning, setShowInitialWarning] = useState(true);
    const [showHighVolumeWarning, setShowHighVolumeWarning] = useState(false);
    const [showInstructions, setShowInstructions] = useState(false);
    const [showImpressum, setShowImpressum] = useState(false);
    const [showPrivacy, setShowPrivacy] = useState(false);

    const [currentTime, setCurrentTime] = useState(new Date());

    const audioContextRef = useRef<AudioContext | null>(null);
    const preAmpGainNodeRef = useRef<GainNode | null>(null);
    const gainNodeRef = useRef<GainNode | null>(null);
    const pannerNodeRef = useRef<StereoPannerNode | null>(null);
    const eqNodesRef = useRef<BiquadFilterNode[]>([]);
    const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const analyserNodeRef = useRef<AnalyserNode | null>(null);
    const visualizerCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const animationFrameIdRef = useRef<number | null>(null);
    
    useEffect(() => {
        const preferredTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        const savedTheme = localStorage.getItem('theme');
        if(!savedTheme) setTheme(preferredTheme);
    }, [setTheme]);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);

    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    const drawVisualizer = useCallback(() => {
        if (!analyserNodeRef.current || !visualizerCanvasRef.current) {
            return;
        }
        const analyser = analyserNodeRef.current;
        const canvas = visualizerCanvasRef.current;
        const canvasCtx = canvas.getContext('2d');
        if (!canvasCtx) return;

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteFrequencyData(dataArray);

        const barColor = getComputedStyle(document.documentElement).getPropertyValue('--primary');
        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
        
        const barWidth = (canvas.width / bufferLength) * 2.5;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            const barHeight = dataArray[i] * (canvas.height / 256.0);
            canvasCtx.fillStyle = barColor;
            canvasCtx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
            x += barWidth + 1;
        }

        animationFrameIdRef.current = requestAnimationFrame(drawVisualizer);
    }, []);

    useEffect(() => {
        if (isStarted) {
            animationFrameIdRef.current = requestAnimationFrame(drawVisualizer);
        }
        return () => {
            if (animationFrameIdRef.current) {
                cancelAnimationFrame(animationFrameIdRef.current);
                animationFrameIdRef.current = null;
            }
        };
    }, [isStarted, drawVisualizer]);


    const initAudio = useCallback(async () => {
        if (audioContextRef.current) return;
        try {
            const audioConstraints = {
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
                video: false
            };
            const stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
            streamRef.current = stream;
            
            const context = new AudioContext({ latencyHint: 'interactive' });
            audioContextRef.current = context;

            const source = context.createMediaStreamSource(stream);
            sourceNodeRef.current = source;

            const preAmpGainNode = context.createGain();
            preAmpGainNode.gain.value = preAmp / 100;
            preAmpGainNodeRef.current = preAmpGainNode;

            const analyserNode = context.createAnalyser();
            analyserNode.fftSize = 256;
            analyserNodeRef.current = analyserNode;
            
            const eqNodes = EQ_FREQUENCIES.map((freq) => {
                const eqNode = context.createBiquadFilter();
                eqNode.type = 'peaking';
                eqNode.frequency.value = freq;
                eqNode.Q.value = 1.41;
                eqNode.gain.value = eqValues[freq] || 0;
                return eqNode;
            });
            eqNodesRef.current = eqNodes;

            const pannerNode = context.createStereoPanner();
            pannerNode.pan.value = balance / 100;
            pannerNodeRef.current = pannerNode;

            const gainNode = context.createGain();
            gainNode.gain.value = volume / 100;
            gainNodeRef.current = gainNode;
            
            let lastNode: AudioNode = source;
            lastNode.connect(preAmpGainNode);
            lastNode = preAmpGainNode;

            lastNode.connect(analyserNode);
            lastNode = analyserNode;

            for (const eqNode of eqNodes) {
                lastNode.connect(eqNode);
                lastNode = eqNode;
            }
            lastNode.connect(pannerNode);
            lastNode = pannerNode;
            lastNode.connect(gainNode);
            gainNode.connect(context.destination);

            setIsStarted(true);
        } catch (err) {
            console.error('Error initializing audio:', err);
            alert('Mikrofonzugriff wurde verweigert oder die Audio-Einstellungen werden nicht unterstützt. Die App kann nicht ohne Mikrofon funktionieren.');
        }
    }, [volume, eqValues, preAmp, balance]);

    const handleStartFromModal = () => {
        setShowInitialWarning(false);
        initAudio();
    };
    
    const handleStop = () => {
        if (animationFrameIdRef.current) {
            cancelAnimationFrame(animationFrameIdRef.current);
            animationFrameIdRef.current = null;
        }
        if(audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }
        if(streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        preAmpGainNodeRef.current = null;
        gainNodeRef.current = null;
        pannerNodeRef.current = null;
        eqNodesRef.current = [];
        sourceNodeRef.current = null;
        analyserNodeRef.current = null;
        setIsStarted(false);
    }

    const handlePreAmpChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newPreAmp = parseInt(e.target.value, 10);
        setPreAmp(newPreAmp);
        if (preAmpGainNodeRef.current && audioContextRef.current) {
            preAmpGainNodeRef.current.gain.setValueAtTime(newPreAmp / 100, audioContextRef.current.currentTime);
        }
        setSelectedProfile('custom');
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseInt(e.target.value, 10);
        setVolume(newVolume);
        if (gainNodeRef.current && audioContextRef.current) {
            gainNodeRef.current.gain.setValueAtTime(newVolume / 100, audioContextRef.current.currentTime);
        }
        if (newVolume > 270 && !showHighVolumeWarning) {
            setShowHighVolumeWarning(true);
        }
        setSelectedProfile('custom');
    };

    const handleEqChange = (freq: number, value: number) => {
        setEqValues(prev => ({ ...prev, [freq]: value }));
        const eqNode = eqNodesRef.current.find(n => n.frequency.value === freq);
        if (eqNode && audioContextRef.current) {
            eqNode.gain.setValueAtTime(value, audioContextRef.current.currentTime);
        }
        setSelectedProfile('custom');
    };

    const handleBalanceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newBalance = parseInt(e.target.value, 10);
        setBalance(newBalance);
        if (pannerNodeRef.current && audioContextRef.current) {
            pannerNodeRef.current.pan.setValueAtTime(newBalance / 100, audioContextRef.current.currentTime);
        }
        setSelectedProfile('custom');
    };
    
    const applyProfile = (profile: Profile) => {
        const safePreAmp = Number.isFinite(profile.preAmp) ? profile.preAmp : DEFAULT_PRE_AMP;
        const safeVolume = Number.isFinite(profile.volume) ? profile.volume : DEFAULT_VOLUME;
        const safeBalance = Number.isFinite(profile.balance) ? profile.balance : DEFAULT_BALANCE;
        
        const safeEq: EQSettings = {};
        EQ_FREQUENCIES.forEach(freq => {
            const value = profile.eq?.[freq];
            safeEq[freq] = Number.isFinite(value) ? value! : 0;
        });

        setPreAmp(safePreAmp);
        setVolume(safeVolume);
        setEqValues(safeEq);
        setBalance(safeBalance);

        if (audioContextRef.current) {
            if (preAmpGainNodeRef.current) {
                preAmpGainNodeRef.current.gain.setValueAtTime(safePreAmp / 100, audioContextRef.current.currentTime);
            }
            if (gainNodeRef.current) {
                gainNodeRef.current.gain.setValueAtTime(safeVolume / 100, audioContextRef.current.currentTime);
            }
            if (pannerNodeRef.current) {
                pannerNodeRef.current.pan.setValueAtTime(safeBalance / 100, audioContextRef.current.currentTime);
            }
            eqNodesRef.current.forEach(node => {
                const gainValue = safeEq[node.frequency.value];
                node.gain.setValueAtTime(gainValue, audioContextRef.current!.currentTime);
            });
        }
    }

    const handleProfileSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const profileName = e.target.value;
        setSelectedProfile(profileName);
        if(profileName === 'default') {
             applyProfile({name: 'default', preAmp: DEFAULT_PRE_AMP, volume: DEFAULT_VOLUME, eq: DEFAULT_EQ, balance: DEFAULT_BALANCE});
             return;
        }
        if(profileName === 'custom') return;

        const allProfiles = [...PREDEFINED_PROFILES, ...customProfiles];
        const profile = allProfiles.find(p => p.name === profileName);
        if(profile) {
            applyProfile(profile);
        }
    }
    
    const handleSaveProfile = () => {
        const name = prompt('Geben Sie einen Namen für das neue Profil ein:');
        if(name && !PREDEFINED_PROFILES.find(p => p.name === name) && !customProfiles.find(p => p.name === name)) {
            const newProfile: Profile = { name, preAmp, volume, eq: eqValues, balance };
            setCustomProfiles(prev => [...prev, newProfile]);
            alert(`Profil "${name}" gespeichert!`);
            setSelectedProfile(name);
        } else if (name) {
            alert('Ein Profil mit diesem Namen existiert bereits.');
        }
    };

    const handleReset = () => {
        applyProfile({name: 'default', preAmp: DEFAULT_PRE_AMP, volume: DEFAULT_VOLUME, eq: DEFAULT_EQ, balance: DEFAULT_BALANCE});
        setSelectedProfile('default');
    };

    const toggleTheme = () => setTheme(prev => (prev === 'light' ? 'dark' : 'light'));
    
    const renderSlider = (label: string, value: number, min: number, max: number, step: number, unit: string, onChange: (value: number) => void, containerClass = "slider-container") => {
        const backgroundSize = ((value - min) * 100) / (max - min) + '%';
        return (
            <div className={containerClass} key={label}>
                <label htmlFor={label}>{label}</label>
                <input
                    type="range"
                    id={label}
                    min={min}
                    max={max}
                    step={step}
                    value={value}
                    onChange={e => onChange(Number(e.target.value))}
                    style={{ backgroundSize }}
                    aria-label={`${label} Regler`}
                    aria-valuemin={min}
                    aria-valuemax={max}
                    aria-valuenow={value}
                />
                <span className="value">{value}{unit}</span>
            </div>
        );
    };

    const formatBalanceValue = (value: number) => {
        if (value === 0) return 'Mitte';
        if (value > 0) return `R ${value}`;
        return `L ${-value}`;
    };

    return (
        <div className="app-container">
            <header className="header">
                <div className="time-date">
                    <div className="time">{currentTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</div>
                    <div>{currentTime.toLocaleDateString('de-DE')}</div>
                </div>
                 <h1 className="header-title">Klangnah</h1>
                <div className="controls">
                    <button className="icon-btn" onClick={() => setShowInstructions(true)} aria-label="Anleitung anzeigen">
                         <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>
                    </button>
                    <button className="icon-btn" onClick={toggleTheme} aria-label="Theme wechseln">
                        {theme === 'light' ? 
                         <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-5.4-5.4c0-1.54.65-2.94 1.68-3.96A8.91 8.91 0 0 0 12 3z"/></svg> :
                         <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24"><path d="M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm0-10c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4z"/></svg>}
                    </button>
                </div>
            </header>

            <main className="main-content">
                {isStarted ? (
                    <>
                    <div className="control-card">
                        <h2>Vorverstärkung (Pre-Amp)</h2>
                        <canvas ref={visualizerCanvasRef} className="visualizer" width="600" height="80"></canvas>
                        {renderSlider('Pre-Amp', preAmp, 0, 300, 1, '%', (v) => handlePreAmpChange({ target: { value: String(v) } } as any))}
                    </div>

                    <div className="control-card">
                        <h2>Master-Lautstärke</h2>
                        {renderSlider('Volume', volume, 0, 300, 1, '%', (v) => handleVolumeChange({ target: { value: String(v) } } as any))}
                    </div>
                    
                    <div className="control-card">
                        <h2>Links-Rechts-Balance</h2>
                        <div className="slider-container balance-slider-container">
                            <label htmlFor="balance">Balance</label>
                            <input
                                type="range"
                                id="balance"
                                min={-100}
                                max={100}
                                step={1}
                                value={balance}
                                onChange={handleBalanceChange}
                                style={{ backgroundSize: `${((balance + 100) * 100) / 200}%` }}
                                aria-label="Balance Regler"
                            />
                            <span className="value">{formatBalanceValue(balance)}</span>
                        </div>
                    </div>

                    <div className="control-card">
                        <h2>Equalizer</h2>
                        <div className="slider-group">
                        {EQ_FREQUENCIES.map(freq => 
                            renderSlider(`${freq < 1000 ? freq : freq/1000}${freq < 1000 ? 'Hz' : 'kHz'}`, eqValues[freq] || 0, -20, 20, 1, 'dB', (v) => handleEqChange(freq, v))
                        )}
                        </div>
                    </div>

                    <div className="control-card">
                         <h2>Profile</h2>
                         <div className="profile-controls">
                            <select value={selectedProfile} onChange={handleProfileSelect} aria-label="Profil auswählen">
                                <option value="default">Standard</option>
                                <optgroup label="Vordefiniert">
                                    {PREDEFINED_PROFILES.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                                </optgroup>
                                {customProfiles.length > 0 && <optgroup label="Meine Profile">
                                    {customProfiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                                </optgroup>}
                                {selectedProfile === 'custom' && <option value="custom" disabled>Benutzerdefiniert</option>}
                            </select>
                            <button className="btn" onClick={handleSaveProfile}>Speichern</button>
                            <button className="btn" onClick={handleReset}>Zurücksetzen</button>
                         </div>
                    </div>
                    <div className="control-card stop-container">
                        <button className="btn btn-danger" onClick={handleStop}>Hörhilfe stoppen</button>
                    </div>
                    </>
                ) : (
                    !showInitialWarning && (
                        <div className="start-placeholder">
                            <h2>Gestoppt</h2>
                            <p>Die Hörhilfe ist momentan nicht aktiv.</p>
                            <button className="btn btn-primary" onClick={initAudio}>Hörhilfe starten</button>
                        </div>
                    )
                )}
            </main>
            
            <footer className="footer">
                <div className="links">
                    <button onClick={() => setShowImpressum(true)}>Impressum</button>
                    <button onClick={() => setShowPrivacy(true)}>Datenschutz</button>
                </div>
                <div>© 2025 Klangnah. Eine professionelle Hörhilfe-Anwendung.</div>
            </footer>

            <Modal show={showInitialWarning}>
                <h2>Wichtiger Hinweis</h2>
                <p className="icon">⚠️</p>
                <p>Schließen Sie unbedingt Kopfhörer an, bevor Sie Klangnah starten, um Rückkopplungen zu vermeiden!</p>
                <p>Ohne Kopfhörer können laute Rückkopplungen entstehen, die Ihr Gehör schädigen können.</p>
                <div className="modal-actions">
                    <button className="btn btn-primary" onClick={handleStartFromModal}>Verstanden – Starten</button>
                </div>
            </Modal>

            <Modal show={showHighVolumeWarning}>
                 <h2>Warnung: Sehr hohe Lautstärke</h2>
                <p className="icon">⚠️</p>
                <p>Sehr hohe Lautstärke (über 270%) kann Ihr Gehör schädigen. Bitte reduzieren Sie die Lautstärke vorsichtig.</p>
                <p>Auch bei Hörbeeinträchtigung sollten Sie extreme Lautstärken vermeiden.</p>
                <div className="modal-actions">
                    <button className="btn btn-primary" onClick={() => setShowHighVolumeWarning(false)}>Verstanden</button>
                </div>
            </Modal>
            
            <Modal show={showInstructions}>
                <div className="modal-content-scrollable">
                    <h2 style={{textAlign: 'center'}}>Anleitung zur Verwendung</h2>
                    <h3>❗ Wichtiger Sicherheitshinweis</h3>
                    <p>Schließen Sie unbedingt Kopfhörer an Ihr Gerät an, um gefährliche Rückkopplungen zu vermeiden.</p>
                    <h3>1. Kopfhörer anschließen</h3>
                    <p>Stellen Sie sicher, dass Ihre Kopfhörer fest mit dem Gerät verbunden sind, bevor Sie die App starten.</p>
                    <h3>2. Hörhilfe starten</h3>
                    <p>Klicken Sie auf den "Verstanden - Starten" Knopf im Warnhinweis. Erlauben Sie im aufkommenden Fenster den Zugriff auf Ihr Mikrofon. Um die Übertragung zu beenden, klicken Sie auf "Hörhilfe stoppen".</p>
                    <h3>3. Verstärkung, Visualizer & Balance</h3>
                    <p><strong>Vorverstärkung (Pre-Amp):</strong> Besonders auf Mobilgeräten ist das Mikrofonsignal oft leise. Der <strong>Audio-Visualizer</strong> darüber zeigt Ihnen das ankommende Signal in Echtzeit. Heben Sie mit dem Regler das Eingangssignal auf ein gutes Niveau an, sodass die Balken deutlich ausschlagen, aber nicht permanent am oberen Anschlag sind.</p>
                    <p><strong>Master-Lautstärke:</strong> Regeln Sie hiermit die finale Lautstärke, die an Ihre Kopfhörer geht. Eine Erhöhung bis zu 300% ist möglich, aber seien Sie vorsichtig.</p>
                    <p><strong>Links-Rechts-Balance:</strong> Falls Sie auf einem Ohr schlechter hören, können Sie mit diesem Regler die Lautstärke zwischen dem linken und rechten Kopfhörer verschieben, um dies auszugleichen.</p>
                    <h3>4. Equalizer verwenden</h3>
                    <p>Nutzen Sie die sechs Equalizer-Regler, um einzelne Frequenzbereiche anzuheben oder abzusenken. Der Visualizer hilft Ihnen dabei, zu "sehen", welche Frequenzen zu laut oder zu leise sind. Besonders der 125Hz-Regler hilft, fehlende Bässe auf Mobilgeräten auszugleichen.</p>
                    <h3>5. Profile nutzen</h3>
                    <p>Wählen Sie vordefinierte Profile für gängige Situationen oder speichern Sie Ihre eigenen Einstellungen (inklusive Balance) für den schnellen Zugriff.</p>
                    <h3>Zusätzliche Tipps:</h3>
                    <ul>
                      <li>Verwenden Sie die "Speichern"-Funktion, um Ihre Einstellungen als neues Profil zu sichern.</li>
                      <li>Bei Lautstärken über 270% erscheint eine Sicherheitswarnung.</li>
                      <li>Die App ist speziell als Alltagshilfe gedacht, z.B. bei chronischen Mittelohrentzündungen, um Gespräche besser zu verstehen.</li>
                    </ul>
                    <h3>Haftungsausschluss</h3>
                    <p>Diese Anwendung dient als Hörhilfe und ersetzt keine professionelle medizinische Beratung oder ein medizinisches Hörgerät. Bei anhaltenden Hörproblemen konsultieren Sie bitte einen HNO-Arzt.</p>
                </div>
                 <div className="modal-actions">
                    <button className="btn btn-primary" onClick={() => setShowInstructions(false)}>Schließen</button>
                </div>
            </Modal>
            
            <Modal show={showImpressum}>
                <div className="modal-content-scrollable" style={{textAlign: 'left'}}>
                    <h2>Impressum</h2>
                    <p>Angaben gemäß § 5 TMG</p>
                    <p>Max Mustermann<br/>Musterstraße 1<br/>12345 Musterstadt</p>
                    <p><strong>Kontakt:</strong><br/>Telefon: 0123-456789<br/>E-Mail: max@mustermann.de</p>
                </div>
                 <div className="modal-actions">
                    <button className="btn btn-primary" onClick={() => setShowImpressum(false)}>Schließen</button>
                </div>
            </Modal>
            
            <Modal show={showPrivacy}>
                <div className="modal-content-scrollable">
                    <h2 style={{ textAlign: 'center' }}>Datenschutzerklärung</h2>

                    <h3>Datenverarbeitung auf Ihrem Gerät</h3>
                    <p>
                        Diese Anwendung wurde mit dem Fokus auf maximalen Datenschutz entwickelt. Alle Kernfunktionen, insbesondere die Verarbeitung Ihrer Audiodaten, finden ausschließlich in Echtzeit auf Ihrem Gerät statt.
                    </p>
                    <ul>
                        <li><strong>Keine Audiospeicherung:</strong> Es werden keine Audiodaten von Ihrem Mikrofon aufgezeichnet, gespeichert oder an externe Server gesendet.</li>
                        <li><strong>Lokale Einstellungen:</strong> Alle von Ihnen vorgenommenen Einstellungen, wie Lautstärke, Equalizer-Werte und gespeicherte Profile, werden ausschließlich im lokalen Speicher (Local Storage) Ihres Webbrowsers gesichert. Diese Daten verlassen Ihr Gerät nicht.</li>
                    </ul>

                    <h3>Nutzung von Google Fonts</h3>
                    <p>
                        Um eine einheitliche und gut lesbare Darstellung der Benutzeroberfläche zu gewährleisten, verwenden wir die Schriftart "Inter", die über Google Fonts bereitgestellt wird. Wenn Sie die Anwendung laden, baut Ihr Browser eine direkte Verbindung zu den Servern von Google auf, um die Schriftart herunterzuladen.
                    </p>
                    <p>
                        Bei diesem Vorgang wird Ihre IP-Adresse an Google übertragen. Dies ist technisch notwendig, damit die Schriftart an Ihren Browser ausgeliefert werden kann. Wir haben keinen Einfluss auf diese Datenübertragung.
                    </p>
                    <p>
                        Weitere Informationen zum Datenschutz bei Google und zu Google Fonts finden Sie in der Datenschutzerklärung von Google: <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">https://policies.google.com/privacy</a>
                    </p>
                </div>
                <div className="modal-actions">
                    <button className="btn btn-primary" onClick={() => setShowPrivacy(false)}>Schließen</button>
                </div>
            </Modal>
        </div>
    );
};

const container = document.getElementById('root');
if(container) {
    const root = createRoot(container);
    root.render(<App />);
}