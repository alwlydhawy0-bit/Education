/**
 * Minimal in-process domain event bus.
 *
 * Scope decision (see docs/architecture/adr/0006-events.md): this is
 * deliberately NOT a message broker. It exists to let one domain react to
 * another without importing it — e.g. `analytics` reacting to
 * `AssessmentCompleted` without `assessments` knowing analytics exists.
 *
 * Delivery semantics are explicit and weak on purpose:
 *   - handlers run AFTER the publishing transaction commits (the caller is
 *     responsible for that ordering; see `TransactionalOutbox` in the API app),
 *   - a failing handler is logged and does NOT roll back the publisher,
 *   - there is no retry and no cross-process delivery.
 *
 * Therefore: never place a security control or a data-integrity invariant in an
 * event handler. Those belong in the publishing transaction.
 */
export interface DomainEvent<TName extends string = string, TPayload = unknown> {
  readonly name: TName;
  readonly payload: TPayload;
  readonly occurredAt: Date;
  /** Correlates the event with the request that produced it, for tracing. */
  readonly correlationId: string;
}

export type EventHandler<E extends DomainEvent> = (event: E) => Promise<void> | void;

export interface EventBus {
  subscribe<E extends DomainEvent>(name: E['name'], handler: EventHandler<E>): () => void;
  publish(event: DomainEvent): Promise<void>;
}

export interface EventBusDeps {
  /** Called when a handler throws. Must not rethrow. */
  onHandlerError: (event: DomainEvent, error: unknown) => void;
}

export function createInProcessEventBus(deps: EventBusDeps): EventBus {
  const handlers = new Map<string, Set<EventHandler<never>>>();

  return {
    subscribe(name, handler) {
      const set = handlers.get(name) ?? new Set();
      set.add(handler as EventHandler<never>);
      handlers.set(name, set);
      return () => {
        set.delete(handler as EventHandler<never>);
      };
    },

    async publish(event) {
      const set = handlers.get(event.name);
      if (!set) return;
      // Handlers are isolated from each other: one failure must not prevent the
      // rest from running, and must never surface to the publisher.
      for (const handler of set) {
        try {
          await (handler as EventHandler<DomainEvent>)(event);
        } catch (error) {
          deps.onHandlerError(event, error);
        }
      }
    },
  };
}
