import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import {
  INITIAL_ATHLETES,
  INITIAL_EXERCISES,
  INITIAL_MICROCYCLES,
  generate28DayACWRData,
  calculateReadiness
} from './src/mockData';
import { Athlete, WellnessSurvey, WorkloadEntry, Microcycle, ACWRAlert } from './src/types';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // Initialize in-memory state with mock data
  let athletesData: Athlete[] = [...INITIAL_ATHLETES];
  let exercisesData = [...INITIAL_EXERCISES];
  let microcyclesData: Microcycle[] = [...INITIAL_MICROCYCLES];
  let wellnessLogsData: WellnessSurvey[] = [];
  let workloadLogsData: WorkloadEntry[] = [];

  // Gemini AI Client
  let aiClient: GoogleGenAI | null = null;
  function getGeminiClient(): GoogleGenAI {
    if (!aiClient) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        console.warn('GEMINI_API_KEY environment variable is not defined.');
      }
      aiClient = new GoogleGenAI({
        apiKey: apiKey || 'dummy-key',
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
    }
    return aiClient;
  }

  // --- API ROUTES ---

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Get all athletes with squad filter
  app.get('/api/athletes', (req, res) => {
    const { squad } = req.query;
    let filtered = athletesData;
    if (squad && squad !== 'All') {
      filtered = filtered.filter(a => a.squad === squad);
    }
    res.json(filtered);
  });

  // Get single athlete profile with ACWR timeline
  app.get('/api/athletes/:id', (req, res) => {
    const athlete = athletesData.find(a => a.id === req.params.id);
    if (!athlete) {
      return res.status(404).json({ error: 'Athlete not found' });
    }
    const timeline = generate28DayACWRData(athlete);
    res.json({ athlete, timeline });
  });

  // Post Daily Wellness Survey
  app.post('/api/athletes/:id/wellness', (req, res) => {
    const athleteId = req.params.id;
    const athlete = athletesData.find(a => a.id === athleteId);
    if (!athlete) {
      return res.status(404).json({ error: 'Athlete not found' });
    }

    const { sleepHours, sleepQuality, soreness, fatigue, stress, mood, notes } = req.body;

    const readinessScore = calculateReadiness({
      sleepHours: Number(sleepHours),
      sleepQuality: Number(sleepQuality),
      soreness: Number(soreness),
      fatigue: Number(fatigue),
      stress: Number(stress),
      mood: Number(mood)
    });

    const newSurvey: WellnessSurvey = {
      id: `wel-${Date.now()}`,
      athleteId,
      date: new Date().toISOString().split('T')[0],
      sleepHours: Number(sleepHours),
      sleepQuality: Number(sleepQuality),
      soreness: Number(soreness),
      fatigue: Number(fatigue),
      stress: Number(stress),
      mood: Number(mood),
      readinessScore,
      notes
    };

    wellnessLogsData.push(newSurvey);

    // Update athlete profile state
    athlete.readinessScore = readinessScore;
    athlete.sleepHours = Number(sleepHours);
    athlete.sorenessLevel = Number(soreness);
    athlete.fatigueLevel = Number(fatigue);
    athlete.stressLevel = Number(stress);
    athlete.moodLevel = Number(mood);
    athlete.lastSurveyDate = newSurvey.date;

    res.json({ success: true, survey: newSurvey, athlete });
  });

  // Log Workload Session (sRPE = duration * RPE)
  app.post('/api/workloads', (req, res) => {
    const { athleteId, sessionName, sessionType, durationMinutes, rpe } = req.body;
    const athlete = athletesData.find(a => a.id === athleteId);
    if (!athlete) {
      return res.status(404).json({ error: 'Athlete not found' });
    }

    const dur = Number(durationMinutes);
    const rpeVal = Number(rpe);
    const sRPE = dur * rpeVal;

    const newEntry: WorkloadEntry = {
      id: `wk-${Date.now()}`,
      athleteId,
      date: new Date().toISOString().split('T')[0],
      sessionName,
      sessionType,
      durationMinutes: dur,
      rpe: rpeVal,
      sRPE
    };

    workloadLogsData.push(newEntry);

    // Recompute athlete ACWR ratio dynamically
    const recentSpike = sRPE > 650 || rpeVal >= 9;
    if (recentSpike) {
      athlete.currentACWR = Number((athlete.currentACWR + 0.15).toFixed(2));
      if (athlete.currentACWR > 1.5) {
        athlete.acwrStatus = 'Spike';
      } else if (athlete.currentACWR > 1.3) {
        athlete.acwrStatus = 'Elevated';
      }
    }

    res.json({ success: true, entry: newEntry, athlete });
  });

  // Team-wide ACWR & Risk Overview
  app.get('/api/acwr/overview', (req, res) => {
    const alerts: ACWRAlert[] = [];
    
    athletesData.forEach(ath => {
      if (ath.acwrStatus === 'Spike' || ath.currentACWR > 1.5) {
        alerts.push({
          id: `alt-${ath.id}`,
          athleteId: ath.id,
          athleteName: ath.name,
          squad: ath.squad,
          acwr: ath.currentACWR,
          status: 'Spike',
          acuteLoad: Math.round(ath.currentACWR * 520),
          chronicLoad: 520,
          message: `Workload ratio spike of ${ath.currentACWR} puts athlete at elevated acute injury risk zone (>1.5).`,
          recommendation: 'Reduce high-velocity sprinting and cap max weight reps by 20% in upcoming microcycle.'
        });
      } else if (ath.readinessScore < 60) {
        alerts.push({
          id: `alt-red-${ath.id}`,
          athleteId: ath.id,
          athleteName: ath.name,
          squad: ath.squad,
          acwr: ath.currentACWR,
          status: ath.acwrStatus,
          acuteLoad: 480,
          chronicLoad: 500,
          message: `Readiness score dropped to ${ath.readinessScore}% due to elevated fatigue/soreness levels.`,
          recommendation: 'Swap main compound lifts for active recovery, sauna, or contrast therapy.'
        });
      }
    });

    res.json({
      totalAthletes: athletesData.length,
      optimalCount: athletesData.filter(a => a.acwrStatus === 'Optimal').length,
      elevatedCount: athletesData.filter(a => a.acwrStatus === 'Elevated').length,
      spikeCount: athletesData.filter(a => a.acwrStatus === 'Spike').length,
      underloadedCount: athletesData.filter(a => a.acwrStatus === 'Underloaded').length,
      avgReadiness: Math.round(athletesData.reduce((acc, a) => acc + a.readinessScore, 0) / athletesData.length),
      alerts
    });
  });

  // Microcycles
  app.get('/api/microcycles', (req, res) => {
    res.json(microcyclesData);
  });

  app.post('/api/microcycles', (req, res) => {
    const newCycle: Microcycle = {
      id: `mc-${Date.now()}`,
      ...req.body,
      createdAt: new Date().toISOString().split('T')[0]
    };
    microcyclesData.unshift(newCycle);
    res.json({ success: true, microcycle: newCycle });
  });

  app.post('/api/microcycles/:id/assign', (req, res) => {
    const { athleteIds } = req.body;
    const cycle = microcyclesData.find(m => m.id === req.params.id);
    if (!cycle) {
      return res.status(404).json({ error: 'Microcycle not found' });
    }
    cycle.assignedAthleteIds = athleteIds;
    res.json({ success: true, microcycle: cycle });
  });

  // Exercise library
  app.get('/api/exercises', (req, res) => {
    res.json(exercisesData);
  });

  // AI Gemini Copilot Endpoint
  app.post('/api/ai/coach-copilot', async (req, res) => {
    try {
      const { prompt, mode, contextData } = req.body;
      const ai = getGeminiClient();

      let systemInstruction = `You are HEME AI, an elite Strength & Conditioning Sports Science Copilot assisting high-performance sports coaches.
Provide concise, actionable, evidence-based recommendations on periodization, ACWR workload management, velocity-based training, and athlete recovery strategies.
Style guidelines: Professional, direct, practical sports performance tone. Avoid generic fluff.`;

      let userPrompt = prompt;

      if (mode === 'acwr_analysis') {
        userPrompt = `Analyze the following team workload and readiness alerts: ${JSON.stringify(contextData)}. Provide a 3-bullet action plan for the coach to mitigate injury risk without compromising fitness gains.`;
      } else if (mode === 'generate_microcycle') {
        userPrompt = `Generate a 1-week microcycle training structure for ${contextData.squad || 'Rugby'} focusing on ${contextData.focusPhase || 'Power & Speed'}. Include day-by-day focus, key lifts, target %1RM/RPE, tempo, and rest intervals.`;
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: userPrompt,
        config: {
          systemInstruction,
          temperature: 0.7
        }
      });

      res.json({ response: response.text });
    } catch (err: any) {
      console.error('Gemini API error:', err);
      res.status(500).json({
        error: 'Failed to generate AI insights',
        details: err?.message || 'Unknown server error'
      });
    }
  });

  // Vite middleware setup for dev vs static build for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`HEME Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
