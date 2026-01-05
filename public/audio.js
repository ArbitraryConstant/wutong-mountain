// Atmospheric Audio Engine
class AtmosphericAudio {
    constructor() {
        this.audioContext = null;
        this.isEnabled = false;
        this.currentSoundscape = null;
        this.oscillators = [];
        this.gainNodes = [];
        this.masterGain = null;
    }

    initialize() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.audioContext.createGain();
            this.masterGain.connect(this.audioContext.destination);
            this.masterGain.gain.value = 0.3; // Master volume
        }
    }

    toggle() {
        this.isEnabled = !this.isEnabled;
        
        if (this.isEnabled) {
            this.initialize();
            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }
        } else {
            this.stopAll();
        }
        
        return this.isEnabled;
    }

    stopAll() {
        this.oscillators.forEach(osc => {
            try {
                osc.stop();
            } catch (e) {
                // Already stopped
            }
        });
        this.oscillators = [];
        this.gainNodes = [];
    }

    createTone(frequency, volume = 0.1, type = 'sine') {
        if (!this.isEnabled || !this.audioContext) return null;

        const oscillator = this.audioContext.createOscillator();
        const gainNode = this.audioContext.createGain();
        
        oscillator.type = type;
        oscillator.frequency.value = frequency;
        
        gainNode.gain.value = 0;
        gainNode.gain.linearRampToValueAtTime(volume, this.audioContext.currentTime + 2);
        
        oscillator.connect(gainNode);
        gainNode.connect(this.masterGain);
        
        oscillator.start();
        
        this.oscillators.push(oscillator);
        this.gainNodes.push(gainNode);
        
        return { oscillator, gainNode };
    }

    createNoise(volume = 0.05) {
        if (!this.isEnabled || !this.audioContext) return null;

        const bufferSize = 2 * this.audioContext.sampleRate;
        const noiseBuffer = this.audioContext.createBuffer(1, bufferSize, this.audioContext.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        
        const whiteNoise = this.audioContext.createBufferSource();
        whiteNoise.buffer = noiseBuffer;
        whiteNoise.loop = true;
        
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = 0;
        gainNode.gain.linearRampToValueAtTime(volume, this.audioContext.currentTime + 2);
        
        const filter = this.audioContext.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1000;
        
        whiteNoise.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(this.masterGain);
        
        whiteNoise.start();
        
        this.oscillators.push(whiteNoise);
        this.gainNodes.push(gainNode);
        
        return { whiteNoise, gainNode, filter };
    }

    transitionTo(soundscape, duration = 3) {
        if (!this.isEnabled) return;

        // Fade out current sounds
        this.gainNodes.forEach(gain => {
            gain.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + duration);
        });

        // Clear old oscillators after fade
        setTimeout(() => {
            this.stopAll();
            this.playSoundscape(soundscape);
        }, duration * 1000);
    }

    playSoundscape(type) {
        if (!this.isEnabled) return;

        this.currentSoundscape = type;

        switch(type) {
            case 'mountain':
                // Mountain wind - low rumble + high whistle
                this.createNoise(0.03);
                this.createTone(80, 0.04, 'sine');
                this.createTone(220, 0.02, 'sine');
                this.createTone(440, 0.01, 'sine');
                break;

            case 'city':
                // Utopian city hum - harmonious drones
                this.createTone(100, 0.03, 'sine');
                this.createTone(150, 0.02, 'sine');
                this.createTone(200, 0.02, 'sine');
                this.createNoise(0.01);
                break;

            case 'dream':
                // Ethereal dream state - shimmering tones
                this.createTone(264, 0.03, 'sine'); // C
                this.createTone(330, 0.02, 'sine'); // E
                this.createTone(396, 0.02, 'sine'); // G
                this.createTone(528, 0.01, 'sine'); // High C
                // Add some modulation
                const lfo = this.audioContext.createOscillator();
                lfo.frequency.value = 0.3;
                lfo.connect(this.masterGain.gain);
                lfo.start();
                this.oscillators.push(lfo);
                break;

            case 'nightmare':
                // Dystopian nightmare - dissonant, unsettling
                this.createTone(66, 0.04, 'sawtooth');
                this.createTone(111, 0.03, 'square');
                this.createTone(185, 0.02, 'sawtooth');
                this.createNoise(0.04);
                break;

            default:
                // Silence/ambient
                this.createNoise(0.01);
        }
    }
}

// Global audio instance
const atmosphericAudio = new AtmosphericAudio();