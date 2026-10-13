import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DrumRack, RackDevice } from "@ableton-extensions/sdk";
import { getActiveNotes, getActiveChains, getDrumRack, waitForDevicesReady } from "../src/extension.ts";

describe("getActiveNotes", () => {
  it("extracts unique, unmuted pitches from clips", () => {
    const mockClips = [
      {
        notes: [
          { pitch: 36, muted: false },
          { pitch: 38, muted: false },
          { pitch: 42, muted: true }, // Muted, should be ignored
        ],
      },
      {
        notes: [
          { pitch: 36, muted: false }, // Duplicate pitch, should be deduplicated
          { pitch: 46, muted: false },
        ],
      },
    ] as any;

    const activeNotes = getActiveNotes(mockClips);

    assert.equal(activeNotes.size, 3);
    assert.ok(activeNotes.has(36));
    assert.ok(activeNotes.has(38));
    assert.ok(activeNotes.has(46));
    assert.ok(!activeNotes.has(42)); // Muted
  });

  it("returns an empty set if all notes are muted or clips are empty", () => {
    const mockClips = [
      { notes: [] },
      {
        notes: [
          { pitch: 36, muted: true },
          { pitch: 38, muted: true },
        ],
      },
    ] as any;

    const activeNotes = getActiveNotes(mockClips);
    assert.equal(activeNotes.size, 0);
  });
});

describe("getActiveChains", () => {
  it("returns only chains whose receivingNote matches an active pitch", () => {
    const mockRack = {
      chains: [
        { receivingNote: 36, devices: [{ name: "Kick" }] },
        { receivingNote: 38, devices: [{ name: "Snare" }] },
        { receivingNote: 42, devices: [{ name: "Closed Hat" }] },
        { receivingNote: 46, devices: [{ name: "Open Hat" }] },
      ],
    } as any;

    const activeNotes = new Set([36, 42]); // Only Kick and Closed Hat are played

    const activeChains = getActiveChains(mockRack, activeNotes);

    assert.equal(activeChains.length, 2);
    assert.equal(activeChains[0].receivingNote, 36);
    assert.equal(activeChains[1].receivingNote, 42);
  });

  it("returns an empty array if no chains match active notes", () => {
    const mockRack = {
      chains: [
        { receivingNote: 60, devices: [] },
        { receivingNote: 62, devices: [] },
      ],
    } as any;

    const activeNotes = new Set([36, 38]);
    const activeChains = getActiveChains(mockRack, activeNotes);

    assert.equal(activeChains.length, 0);
  });
});

describe("getDrumRack", () => {
  it("finds a DrumRack located directly on the track", () => {
    const mockDrumRack = Object.create(DrumRack.prototype);

    const mockTrack = {
      devices: [
        { name: "EQ Eight" },
        mockDrumRack,
        { name: "Compressor" },
      ],
    } as any;

    const found = getDrumRack(mockTrack);
    assert.equal(found, mockDrumRack);
  });

  it("finds a DrumRack nested inside an Instrument Rack (RackDevice)", () => {
    const mockNestedDrumRack = Object.create(DrumRack.prototype);

    const mockInstrRack = Object.create(RackDevice.prototype);
    Object.defineProperty(mockInstrRack, "chains", {
      value: [
        {
          devices: [mockNestedDrumRack],
        },
      ],
    });

    const mockTrack = {
      devices: [
        { name: "Utility" },
        mockInstrRack,
      ],
    } as any;

    const found = getDrumRack(mockTrack);
    assert.equal(found, mockNestedDrumRack);
  });

  it("returns undefined if no DrumRack is present", () => {
    const mockTrack = {
      devices: [
        { name: "Wavetable" },
        { name: "Reverb" },
      ],
    } as any;

    const found = getDrumRack(mockTrack);
    assert.equal(found, undefined);
  });
});

describe("waitForDevicesReady", () => {
  it("resolves immediately when drum rack and device handles are ready", async () => {
    const mockDrumRack = Object.create(DrumRack.prototype);
    Object.defineProperty(mockDrumRack, "chains", {
      value: [
        {
          devices: [{ handle: 101, name: "Sampler" }],
        },
      ],
    });

    const mockTrack = {
      devices: [mockDrumRack],
    } as any;

    const result = await waitForDevicesReady(mockTrack, 500);
    assert.equal(result, mockDrumRack);
  });

  it("aborts immediately when signal is already aborted", async () => {
    const mockTrack = { devices: [] } as any;
    const ac = new AbortController();
    ac.abort();

    const start = Date.now();
    await waitForDevicesReady(mockTrack, 1000, ac.signal);
    const duration = Date.now() - start;

    assert.ok(duration < 50, `Expected immediate exit, but took ${duration}ms`);
  });

  it("exits early when signal is aborted mid-wait", async () => {
    const mockTrack = { devices: [] } as any;
    const ac = new AbortController();

    setTimeout(() => ac.abort(), 60);

    const start = Date.now();
    await waitForDevicesReady(mockTrack, 1000, ac.signal);
    const duration = Date.now() - start;

    assert.ok(duration < 250, `Expected early abort, but took ${duration}ms`);
  });
});

