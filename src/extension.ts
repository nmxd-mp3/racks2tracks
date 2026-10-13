import {
  initialize,
  ExtensionContext,
  Song,
  Track,
  MidiTrack,
  DrumRack,
  Chain,
  DrumChain,
  type ActivationContext,
  type Handle,
  MidiClip,
  RackDevice,
} from "@ableton-extensions/sdk";

const API_VERSION = "1.0.0";
type ApiV = typeof API_VERSION;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, API_VERSION);
  const song = context.application.song;

  context.commands.registerCommand("racks2tracks.split", async (handle) => {
    const track = context.getObjectFromHandle(handle as Handle, MidiTrack);

    const clips = track.arrangementClips as MidiClip<ApiV>[];
    if (track.arrangementClips.length === 0) {
      console.log("No clips.");
      return;
    }

    const activeNotes = getActiveNotes(clips);

    const rack = getDrumRack(track);
    if (rack === undefined) {
      console.log("No Drum or Instrument Rack.");
      return;
    }

    const activeChains = getActiveChains(rack, activeNotes);
    if (activeChains.length === 0) {
      console.log("No active chains.");
      return;
    }

    await split(context, track, activeChains);
  });

  context.commands.registerCommand("racks2tracks.deep_split", async (handle) => {
    const track = context.getObjectFromHandle(handle as Handle, MidiTrack);

    const clips = track.arrangementClips as MidiClip<ApiV>[];
    if (track.arrangementClips.length === 0) {
      console.log("No clips.");
      return;
    }

    const activeNotes = getActiveNotes(clips);

    const rack = getDrumRack(track);
    if (rack === undefined) {
      console.log("No Drum or Instrument Rack.");
      return;
    }

    const activeChains = getActiveChains(rack, activeNotes);
    if (activeChains.length === 0) {
      console.log("No active chains.");
      return;
    }

    await deep_split(context, track, activeChains);
  });

  context.ui.registerContextMenuAction(
    "MidiTrack",
    "Split Drum Rack into individual MIDI tracks (fast)",
    "racks2tracks.split",
  );

  context.ui.registerContextMenuAction(
    "MidiTrack",
    "Split Drum Rack into individual MIDI tracks (deep)",
    "racks2tracks.deep_split",
  );
}

async function split(
  context: ExtensionContext<ApiV>,
  track: MidiTrack<ApiV>,
  activeChains: DrumChain<ApiV>[],
) {
  const song = context.application.song;

  await context.ui.withinProgressDialog(
    "Turning racks2tracks (Fast)...",
    { progress: 0 },
    async (update, signal) => {
      const dups: MidiTrack<ApiV>[] = [];

      const checkAbort = async (): Promise<boolean> => {
        if (!signal.aborted) return false;
        while (dups.length > 0) {
          const dup = dups.pop();
          if (dup) {
            try {
              await song.deleteTrack(dup);
            } catch {
              // Ignore if already deleted
            }
          }
        }
        track.mute = false;
        return true;
      };

      if (await checkAbort()) return;

      await update("Duplicating tracks...", 30);
      if (await checkAbort()) return;

      const newDups = (await context.withinTransaction(() => {
        return Promise.all(activeChains.map(() => song.duplicateTrack(track)));
      })) as MidiTrack<ApiV>[];
      dups.push(...newDups);

      if (await checkAbort()) return;

      await update("Isolating and bypassing chains...", 70);
      if (await checkAbort()) return;

      // Fast lookup of pitches that actually have MIDI notes in this beat
      const activePitches = new Set(activeChains.map((c) => c.receivingNote));

      // Consolidated Single Transaction: Name, Filter Notes & Concurrent Bypass
      await context.withinTransaction(() => {
        const bypassPromises: Promise<void>[] = [];

        dups.forEach((dup, i) => {
          dup.mute = false;
          const targetChain = activeChains[i];

          const padName = targetChain.devices[0]?.name || `Pad ${targetChain.receivingNote}`;
          dup.name = `${padName}`;

          for (const clip of dup.arrangementClips as MidiClip<ApiV>[])
            clip.notes = clip.notes.filter((note) => note.pitch === targetChain.receivingNote);

          const dupRack = getDrumRack(dup);
          if (dupRack) {
            for (const chain of dupRack.chains) {
              // Only bypass if it's an active note in the beat, but NOT this track's target pad
              if (
                chain.receivingNote !== targetChain.receivingNote &&
                activePitches.has(chain.receivingNote)
              ) {
                for (const d of chain.devices) {
                  // Fast O(1) check on index 0 before falling back to linear search
                  const onOff =
                    d.parameters[0]?.name === "Device On"
                      ? d.parameters[0]
                      : d.parameters.find((p) => p.name === "Device On");

                  if (onOff) bypassPromises.push(onOff.setValue(0));
                }
              }
            }
          }
        });

        return Promise.all(bypassPromises);
      });

      if (await checkAbort()) return;

      track.mute = true;
      await update("Done!", 100);
    },
  );
}

async function deep_split(
  context: ExtensionContext<ApiV>,
  track: MidiTrack<ApiV>,
  activeChains: DrumChain<ApiV>[],
) {
  const song = context.application.song;

  await context.ui.withinProgressDialog(
    "Turning racks2tracks (Deep)...",
    { progress: 0 },
    async (update, signal) => {
      const size = activeChains.length;
      const baseUnit = 100 / size;
      const createdDups: MidiTrack<ApiV>[] = [];

      const checkAbort = async (): Promise<boolean> => {
        if (!signal.aborted) return false;
        while (createdDups.length > 0) {
          const dup = createdDups.pop();
          if (dup) {
            try {
              await song.deleteTrack(dup);
            } catch {
              // Ignore if already deleted
            }
          }
        }
        track.mute = false;
        return true;
      };

      for (let i = 0; i < size; i++) {
        if (await checkAbort()) return;

        const targetChain = activeChains[i];
        const padName = targetChain.devices[0]?.name || `Pad ${targetChain.receivingNote}`;
        const unitBasePercent = (i / size) * 100;

        // Duplicate track
        await update(
          `[${i + 1}/${size}] Duplicating ${padName}...`,
          Math.round(unitBasePercent + baseUnit * 0.05),
        );
        if (await checkAbort()) return;

        await new Promise((resolve) => setTimeout(resolve, 50));
        if (await checkAbort()) return;

        track.mute = false;
        const dup = (await context.withinTransaction(() => {
          return song.duplicateTrack(track);
        })) as MidiTrack<ApiV>;
        createdDups.push(dup);

        dup.name = `${padName}`;

        if (await checkAbort()) return;

        // Isolate MIDI notes
        await update(
          `[${i + 1}/${size}] Isolating notes for ${padName}...`,
          Math.round(unitBasePercent + baseUnit * 0.55),
        );
        if (await checkAbort()) return;

        for (const clip of dup.arrangementClips as MidiClip<ApiV>[])
          clip.notes = clip.notes.filter((note) => note.pitch === targetChain.receivingNote);

        // Adaptive buffer: wait dynamically until device handles are fully populated
        const dupRack = await waitForDevicesReady(dup, 1500, signal);
        if (await checkAbort()) return;

        dup.mute = false;

        // Update before device deletion
        await update(
          `[${i + 1}/${size}] Cleaning unused devices on ${padName}...`,
          Math.round(unitBasePercent + baseUnit * 0.65),
        );
        if (await checkAbort()) return;

        // Delete devices on unused chains
        if (dupRack) {
          for (const chain of dupRack.chains) {
            if (await checkAbort()) return;
            if (chain.receivingNote !== targetChain.receivingNote) {
              const devices = [...chain.devices];
              for (let j = devices.length - 1; j >= 0; j--) {
                if (await checkAbort()) return;
                await chain.deleteDevice(devices[j]);
              }
            }
          }
        }
      }

      if (await checkAbort()) return;

      // Step 6: Mute source track and wrap up
      await update("Muting source track...", 99);
      if (await checkAbort()) return;

      track.mute = true;
      await update("Done!", 100);
    },
  );
}

export function getActiveNotes(clips: MidiClip<ApiV>[]): Set<number> {
  const activeNotes = new Set<number>();

  for (const clip of clips)
    for (const note of clip.notes) if (!note.muted) activeNotes.add(note.pitch);

  return activeNotes;
}

export function getActiveChains(rack: DrumRack<ApiV>, activeNotes: Set<number>): DrumChain<ApiV>[] {
  const activeChains: DrumChain<ApiV>[] = [];

  for (const chain of rack.chains)
    if (activeNotes.has(chain.receivingNote)) activeChains.push(chain);

  return activeChains;
}

export function getDrumRack(track: MidiTrack<ApiV>): DrumRack<ApiV> | undefined {
  let rack = track.devices.find((d) => d instanceof DrumRack);

  if (rack === undefined) {
    const instrRack = track.devices.find((d) => d instanceof RackDevice);

    if (instrRack !== undefined)
      for (const chain of instrRack.chains) {
        rack = chain.devices.find((d) => d instanceof DrumRack);
        if (rack !== undefined) break;
      }
  }

  return rack;
}

export async function waitForDevicesReady(
  dup: MidiTrack<ApiV>,
  maxWaitMs = 1500,
  signal?: AbortSignal,
): Promise<DrumRack<ApiV> | undefined> {
  const maxAttempts = Math.ceil(maxWaitMs / 25);
  let rack = getDrumRack(dup);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) return rack;
    rack = getDrumRack(dup);
    if (rack && rack.chains && rack.chains.length > 0) {
      const isReady = rack.chains.every(
        (chain) =>
          chain &&
          chain.devices &&
          chain.devices.every((device) => device !== undefined && device.handle !== undefined),
      );
      if (isReady) return rack;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return rack;
}
