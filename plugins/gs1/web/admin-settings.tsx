import { useEffect, useState } from 'react';
import { notify } from '../../../web/notify';
import { Switch } from '../../../web/switch';
import type { Gs1Settings, GtinConflictPage } from '../adapter/store.js';
import { gs1Api } from './api';
import { GtinConflictDialog } from './gtin-conflict-dialog';

/** Saves the GS1 plugin's setting through the plugin's own route.
 *
 * A refusal to resume enforcement names the Assets that block it, which a
 * plain error message cannot, so that answer is handed back whole. */
export async function saveGtinConsistency(enforceGtinConsistency: boolean): Promise<
  | { saved: true; settings: Gs1Settings }
  | { saved: false; error: string; gtinConflicts: GtinConflictPage | null }> {
  try {
    const response = await gs1Api.settings.$patch({ json: { enforceGtinConsistency } });
    const body = await response.json() as { settings?: Gs1Settings; error?: string; gtinConflicts?: GtinConflictPage };
    if (response.ok && body.settings) return { saved: true, settings: body.settings };
    return { saved: false, error: body.error ?? 'Request failed', gtinConflicts: body.gtinConflicts ?? null };
  } catch (error) {
    return { saved: false, error: error instanceof Error ? error.message : 'Request failed', gtinConflicts: null };
  }
}

const settingHelp = 'mt-[-.7rem] mb-[1.15rem] text-[.78rem] text-muted-foreground';

/** The GTIN consistency policy, among the instance settings.
 *
 * A simple discrete preference, so it persists on change like the switches
 * around it. A refused change puts the switch back and says why: either as a
 * line under it, or, when Assets still conflict, as the dialog naming them. */
export function Gs1AdminSettings({ data, disabled }: { data: Gs1Settings; disabled: boolean }) {
  const [enforce, setEnforce] = useState(data.enforceGtinConsistency);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gtinConflicts, setGtinConflicts] = useState<GtinConflictPage | null>(null);
  useEffect(() => { if (!saving) setEnforce(data.enforceGtinConsistency); }, [data.enforceGtinConsistency, saving]);
  async function change(checked: boolean) {
    const previous = enforce;
    setEnforce(checked);
    setSaving(true);
    setError(null);
    const result = await saveGtinConsistency(checked);
    setSaving(false);
    if (result.saved) {
      setEnforce(result.settings.enforceGtinConsistency);
      notify('Instance settings saved');
    } else {
      setEnforce(previous);
      if (result.gtinConflicts) setGtinConflicts(result.gtinConflicts);
      else setError(result.error);
    }
  }
  return <>
    <Switch name="enforceGtinConsistency" checked={enforce} disabled={disabled || saving}
      onCheckedChange={(checked) => { void change(checked); }} label="Enforce GTIN consistency" />
    <p className={settingHelp}>Require GTINs associated with the same Asset to match, including those embedded in SGTINs.</p>
    {error && <p role="alert" className={settingHelp}>Error: {error}</p>}
    <GtinConflictDialog conflicts={gtinConflicts} onClose={() => setGtinConflicts(null)} />
  </>;
}
