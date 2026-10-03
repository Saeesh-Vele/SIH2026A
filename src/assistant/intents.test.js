import { describe, expect, it } from 'vitest';
import { matchVocab, parseIntent } from './intents';
import { CATALOG, describeAction, downstream, InvalidAction, validateAction } from './actions';
import { MODULES } from '../shell/navigation';
import { STORY_META } from '../tour/storyMeta';

const ctx = { station: 'maitri', module: 'overview' };
const acts = (text, c = ctx) => parseIntent(text, c).actions;

describe('parseIntent: the spec examples', () => {
  it('opens a page at another station', () => {
    expect(acts('Open the energy grid for Bharati')).toEqual([{ type: 'navigate', args: { module: 'energy', station: 'bharati' } }]);
    expect(acts('Open the energy grid')).toEqual([{ type: 'navigate', args: { module: 'energy' } }]);
  });

  it('runs a named what-if, switching station first', () => {
    expect(acts("What happens if there's a blizzard at Maitri?", { station: 'bharati' })).toEqual([
      { type: 'switchStation', args: { station: 'maitri' } },
      { type: 'runWhatIf', args: { scenario: 'blizzard', intensity: 1 } },
    ]);
    expect(acts('what if the generator fails')).toEqual([{ type: 'runWhatIf', args: { scenario: 'gen_failure', intensity: 1 } }]);
    expect(acts('simulate a severe fuel leak')[0].args).toEqual({ scenario: 'fuel_leak', intensity: 2 });
  });

  it('shows what depends on a building', () => {
    const r = parseIntent('Show me what depends on the generator', ctx);
    expect(r.actions).toEqual([{ type: 'showDependencyChain', args: { id: 'generator' } }]);
    expect(r.answer).toBe('depends');
  });

  it('starts a story', () => {
    expect(acts('Start the blizzard story')).toEqual([{ type: 'startStory', args: { id: 'blizzard' } }]);
    expect(acts('play the link loss story')).toEqual([{ type: 'startStory', args: { id: 'linkloss' } }]);
  });

  it('mute and stop are controls', () => {
    expect(parseIntent('Mute', ctx)).toEqual({ kind: 'control', control: 'mute' });
    expect(parseIntent('Stop', ctx)).toEqual({ kind: 'control', control: 'stop' });
    expect(parseIntent('stop talking', ctx)).toEqual({ kind: 'control', control: 'stop' });
  });

  it('questions go to the backend', () => {
    for (const q of ['Why is Heating Zone A in warning?', "What's the fuel situation at Maitri?", 'Explain the current anomaly',
      "what's the weather like", 'how is the station doing']) {
      expect(parseIntent(q, ctx).kind).toBe('question');
    }
  });
});

describe('parseIntent: other commands', () => {
  it('alerts, highlight, building panel, station, AI diagnostics', () => {
    expect(acts('show me the alerts')).toEqual([{ type: 'openAlertCentre', args: { tab: 'active' } }]);
    expect(acts('open the alert history')).toEqual([{ type: 'openAlertCentre', args: { tab: 'history' } }]);
    expect(acts('highlight the water plant and the comms tower')).toEqual([{ type: 'highlightComponents', args: { ids: ['waterTank', 'commsMast'] } }]);
    expect(acts('open heating zone b')).toEqual([{ type: 'openBuildingPanel', args: { id: 'heatingB' } }]);
    expect(acts('switch to Bharati')).toEqual([{ type: 'switchStation', args: { station: 'bharati' } }]);
    expect(parseIntent('switch to Maitri', ctx)).toMatchObject({ kind: 'actions', actions: [], already: true });
    expect(acts('open AI diagnostics')).toEqual([{ type: 'openAiDiagnostics', args: {} }]);
    expect(acts('weather')).toEqual([{ type: 'navigate', args: { module: 'environmental' } }]);
  });

  it('demo scenarios are recognised (and confirmed later)', () => {
    expect(acts('trigger a generator failure')).toEqual([{ type: 'triggerDemoScenario', args: { id: 'generator_failure', station: 'maitri' } }]);
    expect(acts('run the co2 spike scenario at Bharati')).toEqual([{ type: 'triggerDemoScenario', args: { id: 'co2_spike', station: 'bharati' } }]);
  });

  it('confirm/cancel only while something waits for an answer', () => {
    expect(parseIntent('yes', { ...ctx, pending: true })).toEqual({ kind: 'control', control: 'confirm' });
    expect(parseIntent('cancel', { ...ctx, pending: true })).toEqual({ kind: 'control', control: 'cancel' });
    expect(parseIntent('yes', ctx).kind).toBe('question');
  });

  it('incident controls only during an incident', () => {
    const inc = { ...ctx, incident: true };
    expect(parseIntent('What should I do next?', inc)).toEqual({ kind: 'control', control: 'next-step' });
    expect(parseIntent('done', inc)).toEqual({ kind: 'control', control: 'tick' });
    expect(parseIntent('snooze', inc)).toEqual({ kind: 'control', control: 'snooze' });
    expect(parseIntent('What should I do next?', ctx).kind).toBe('question');
  });
});

describe('vocabulary', () => {
  it('longest phrase wins', () => {
    expect(matchVocab('open heating zone b', 'buildings')).toEqual(['heatingB']);
    expect(matchVocab('the energy grid', 'modules')).toEqual(['energy']);
  });
  it('covers every page, story and catalogue id', () => {
    expect(new Set(CATALOG.modules)).toEqual(new Set(Object.keys(MODULES)));
    expect(new Set(CATALOG.stories)).toEqual(new Set(Object.keys(STORY_META)));
    for (const kind of ['modules', 'whatIfScenarios', 'stories', 'demoScenarios']) {
      const ids = kind === 'modules' ? CATALOG.modules : CATALOG[kind];
      expect(new Set(Object.keys(CATALOG.vocabulary[kind]))).toEqual(new Set(ids));
    }
  });
});

describe('validateAction (the whitelist)', () => {
  it('accepts, cleans and flags state-changing actions', () => {
    expect(validateAction({ type: 'navigate', args: { module: 'energy', station: 'Bharati' } }, 'maitri'))
      .toEqual({ type: 'navigate', args: { module: 'energy', station: 'bharati' }, stateChanging: false });
    expect(validateAction({ type: 'runWhatIf', args: { scenario: 'blizzard', intensity: 7 } }, 'maitri').args.intensity).toBe(2);
    expect(validateAction({ type: 'triggerDemoScenario', args: { id: 'co2_spike' } }, 'maitri').stateChanging).toBe(true);
    expect(validateAction({ type: 'startStory', args: { id: 'fuel' } }, 'maitri').stateChanging).toBe(true);
  });

  it.each([
    [{ type: 'eval', args: { code: 'x' } }],
    [{ type: 'navigate', args: { module: 'nowhere' } }],
    [{ type: 'navigate', args: {} }],
    [{ type: 'navigate', args: { module: 'energy', href: 'https://x' } }],
    [{ type: 'openBuildingPanel', args: { id: 'reactor' } }],
    [{ type: 'highlightComponents', args: { ids: [] } }],
    [{ type: 'switchStation', args: { station: 'vostok' } }],
    [{ type: 'triggerDemoScenario', args: { id: 'fuel_leak' } }],
    [{ type: 'runWhatIf', args: { scenario: 'blizzard', intensity: 'big' } }],
    [null],
  ])('refuses %j', (a) => {
    expect(() => validateAction(a, 'maitri')).toThrow(InvalidAction);
  });

  it('describes actions for the transcript chips', () => {
    expect(describeAction({ type: 'navigate', args: { module: 'energy' } }, 'maitri')).toBe('Opened Energy grid');
    expect(describeAction({ type: 'showDependencyChain', args: { id: 'generator' } }, 'maitri')).toBe('Showing what depends on Generator Shed');
  });

  it('walks the dependency graph downstream', () => {
    const d = downstream('maitri', 'generator');
    expect(d).toEqual(expect.arrayContaining(['heating', 'heatingB', 'waterTank', 'commsMast', 'livingQuarters', 'lab']));
    expect(d).not.toContain('generator');
    expect(downstream('maitri', 'lab')).toEqual([]);
  });
});
