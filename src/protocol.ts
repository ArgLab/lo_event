import type { Decision, DeliveryOptions } from './types.js';

export const PROBE_INTERVAL_MS = 300;
export const BARRIER_DEADLINE_MS = 5_000;
export const SNAPSHOT_RETRY_MS = 10_000;

type Barrier = 'unevaluated' | 'pending' | 'clear';

/**
 * Reliable-delivery policy with no socket, storage, timer, or ambient clock.
 *
 * Methods receive facts and return decisions. The websocket adapter performs
 * those decisions and reports asynchronous outcomes back with the connection
 * generation that produced them. Identity acknowledgements are deliberately
 * generation-free: an ack is a durable fact about an event, not a socket.
 */
export class DeliveryEngine {
  private readonly autoack: boolean;
  private generationNumber = 0;
  private online = false;
  private paused = false;
  private sending = false;
  private currentSend: { seq: number; eventId: string | null } | null = null;
  private readonly inFlight = new Map<string, number>();

  private barrier: Barrier = 'unevaluated';
  private watermark: number | null = null;
  private barrierElapsed = 0;
  private probeElapsed = 0;
  private lastUnleased: number | null = null;

  private snapshotFrame: string | null = null;
  private snapshotSending = false;
  private snapshotSent = false;
  private snapshotElapsed = 0;

  constructor ({ autoack = false }: DeliveryOptions = {}) {
    this.autoack = autoack;
  }

  generation (): number { return this.generationNumber; }
  barrierIsClear (): boolean { return this.barrier === 'clear'; }
  awaitingAck (): number { return this.inFlight.size; }

  connected (): Decision[] {
    this.generationNumber++;
    this.online = true;
    this.sending = false;
    this.currentSend = null;
    this.barrier = 'unevaluated';
    this.watermark = null;
    this.barrierElapsed = 0;
    this.probeElapsed = 0;
    this.lastUnleased = null;
    this.snapshotSending = false;
    this.snapshotSent = false;
    this.snapshotElapsed = 0;

    const decisions: Decision[] = [{ do: 'rewind' }];
    if (!this.paused) decisions.push({ do: 'resumeSending' });
    decisions.push({ do: 'measureWatermark' });
    return decisions;
  }

  disconnected (): Decision[] {
    this.generationNumber++;
    this.online = false;
    this.sending = false;
    this.currentSend = null;
    this.barrier = 'unevaluated';
    this.snapshotSending = false;
    this.snapshotSent = false;
    this.snapshotElapsed = 0;
    return [{ do: 'pauseSending' }];
  }

  recordLeased (seq: number, eventId: string | null, frame: string): Decision[] {
    if (!this.online || this.paused) return [{ do: 'rewind' }];

    this.sending = true;
    this.currentSend = { seq, eventId };
    const decisions: Decision[] = [];
    if (eventId === null) {
      decisions.push({
        do: 'log',
        level: 'error',
        message: `outbox record ${seq} has no metadata.eventId; sending best-effort and confirming on send`
      });
    } else if (!this.autoack) {
      // Register before the adapter sends: a fast ack must already have a name
      // to storage-id mapping.
      this.inFlight.set(eventId, seq);
    }
    decisions.push({ do: 'sendFrame', frame, seq });
    return decisions;
  }

  sendCompleted (generation: number): Decision[] {
    if (!this.isCurrent(generation) || !this.sending || !this.currentSend) return [];
    const { seq, eventId } = this.currentSend;
    this.sending = false;
    this.currentSend = null;

    const decisions: Decision[] = [];
    if (this.autoack || eventId === null) decisions.push({ do: 'confirmIds', ids: [seq] });
    decisions.push(...this.probeIfPending());
    return decisions;
  }

  sendFailed (generation: number): Decision[] {
    if (!this.isCurrent(generation) || !this.sending || !this.currentSend) return [];
    const { seq, eventId } = this.currentSend;
    this.sending = false;
    this.currentSend = null;
    if (eventId !== null && this.inFlight.get(eventId) === seq) {
      this.inFlight.delete(eventId);
    }
    return [
      { do: 'log', level: 'error', message: `send of outbox record ${seq} failed; rewinding` },
      { do: 'rewind' }
    ];
  }

  ackReceived (eventId: string): Decision[] {
    if (this.autoack) return [];
    const seq = this.inFlight.get(eventId);
    if (seq === undefined) return [];
    this.inFlight.delete(eventId);
    return [{ do: 'confirmIds', ids: [seq] }, ...this.probeIfPending()];
  }

  watermarkResult (generation: number, maxSeq: number | null): Decision[] {
    if (!this.isCurrent(generation) || this.barrier !== 'unevaluated') return [];
    if (maxSeq === null) {
      this.barrier = 'clear';
      return this.askIfReady();
    }
    this.watermark = maxSeq;
    this.barrier = 'pending';
    this.barrierElapsed = 0;
    this.probeElapsed = 0;
    this.lastUnleased = null;
    return [{ do: 'probeQueue', watermark: maxSeq }];
  }

  probeResult (generation: number, unleased: number): Decision[] {
    if (!this.isCurrent(generation) || this.barrier !== 'pending' || this.sending) return [];
    if (unleased > 0) {
      if (this.lastUnleased !== null && unleased < this.lastUnleased) {
        this.barrierElapsed = 0;
      }
      this.lastUnleased = unleased;
      return [];
    }
    this.barrier = 'clear';
    return this.askIfReady();
  }

  measurementFailed (generation: number, operation: string): Decision[] {
    if (!this.isCurrent(generation) || this.barrier === 'clear') return [];
    this.barrier = 'clear';
    return [
      {
        do: 'log',
        level: 'error',
        message: `flush barrier ${operation} failed; requesting potentially stale state`
      },
      ...this.askIfReady()
    ];
  }

  requestState (frame: string): Decision[] {
    this.snapshotFrame = frame;
    this.snapshotSending = false;
    this.snapshotSent = false;
    this.snapshotElapsed = 0;
    return this.askIfReady();
  }

  /** The direct request reached a verified-open socket. Only now does its
   * retry clock begin; merely deciding to ask is not a successful send. */
  stateSendCompleted (generation: number): Decision[] {
    if (!this.isCurrent(generation) || !this.snapshotSending || !this.snapshotFrame) return [];
    this.snapshotSending = false;
    this.snapshotSent = true;
    this.snapshotElapsed = 0;
    return [];
  }

  stateSendFailed (generation: number): Decision[] {
    if (!this.isCurrent(generation) || !this.snapshotSending) return [];
    this.snapshotSending = false;
    return [{ do: 'log', level: 'error', message: 'state snapshot request did not reach an open socket; reconnecting before retry' }];
  }

  stateReceived (): Decision[] {
    this.snapshotFrame = null;
    this.snapshotSending = false;
    this.snapshotSent = false;
    this.snapshotElapsed = 0;
    return [];
  }

  disablerEngaged ({ permanentOptOut = false, permanent = false } = {}): Decision[] {
    this.paused = true;
    const decisions: Decision[] = [{ do: 'pauseSending' }];
    if (permanentOptOut) {
      decisions.push(
        { do: 'log', level: 'error', message: 'permanent privacy opt-out: discarding the stored outbox' },
        { do: 'discardOutbox' }
      );
    } else if (permanent) {
      decisions.push({ do: 'log', level: 'error', message: 'delivery is permanently paused; retained events will remain in the outbox' });
    }
    return decisions;
  }

  disablerReleased (): Decision[] {
    if (!this.paused) return [];
    this.paused = false;
    return this.online ? [{ do: 'resumeSending' }] : [];
  }

  elapsed (ms: number): Decision[] {
    if (!this.online) return [];
    const decisions: Decision[] = [];

    // The deadline covers *unevaluated* as well as pending. A maxSeq promise
    // that never settles must degrade to stale state, never a permanent spinner.
    if (this.barrier !== 'clear') {
      this.barrierElapsed += ms;
      if (this.barrierElapsed >= BARRIER_DEADLINE_MS) {
        this.barrier = 'clear';
        decisions.push({
          do: 'log',
          level: 'error',
          message: 'flush barrier did not settle before its deadline; requesting potentially stale state'
        });
        decisions.push(...this.askIfReady());
      } else if (this.barrier === 'pending') {
        this.probeElapsed += ms;
        if (this.probeElapsed >= PROBE_INTERVAL_MS && !this.sending) {
          this.probeElapsed = 0;
          decisions.push({ do: 'probeQueue', watermark: this.watermark! });
        }
      }
    }

    if (this.snapshotFrame && this.snapshotSent) {
      this.snapshotElapsed += ms;
      if (this.snapshotElapsed >= SNAPSHOT_RETRY_MS) {
        this.snapshotSent = false;
        this.snapshotElapsed = 0;
        decisions.push({ do: 'log', level: 'error', message: 'state snapshot request timed out; asking again' });
        decisions.push(...this.askIfReady());
      }
    }
    return decisions;
  }

  private isCurrent (generation: number): boolean {
    return this.online && generation === this.generationNumber;
  }

  private probeIfPending (): Decision[] {
    if (this.barrier !== 'pending' || this.sending) return [];
    this.probeElapsed = 0;
    return [{ do: 'probeQueue', watermark: this.watermark! }];
  }

  private askIfReady (): Decision[] {
    if (!this.online || this.barrier !== 'clear' || !this.snapshotFrame) return [];
    if (this.snapshotSending || this.snapshotSent) return [];
    this.snapshotSending = true;
    return [{ do: 'askForState', frame: this.snapshotFrame }];
  }
}
