import { PluginEvent } from '@posthog/plugin-scaffold'
import * as Sentry from '@sentry/node'

import { eventDroppedCounter } from '../../../main/ingestion-queues/metrics'
import { runInSpan } from '../../../sentry'
import { Hub, PipelineEvent } from '../../../types'
import { DependencyUnavailableError } from '../../../utils/db/error'
import { timeoutGuard } from '../../../utils/db/utils'
import { normalizeProcessPerson } from '../../../utils/event'
import { status } from '../../../utils/status'
import { captureIngestionWarning, generateEventDeadLetterQueueMessage } from '../utils'
import { createEventStep } from './createEventStep'
import {
    eventProcessedAndIngestedCounter,
    pipelineLastStepCounter,
    pipelineStepDLQCounter,
    pipelineStepErrorCounter,
    pipelineStepMsSummary,
    pipelineStepThrowCounter,
} from './metrics'
import { normalizeEventStep } from './normalizeEventStep'
import { pluginsProcessEventStep } from './pluginsProcessEventStep'
import { populateTeamDataStep } from './populateTeamDataStep'
import { prepareEventStep } from './prepareEventStep'
import { processPersonsStep } from './processPersonsStep'

export type EventPipelineResult = {
    // Promises that the batch handler should await on before committing offsets,
    // contains the Kafka producer ACKs, to avoid blocking after every message.
    ackPromises?: Array<Promise<void>>
    // Only used in tests
    // TODO: update to test for side-effects of running the pipeline rather than
    // this return type.
    lastStep: string
    args: any[]
    error?: string
}

class StepErrorNoRetry extends Error {
    step: string
    args: any[]
    constructor(step: string, args: any[], message: string) {
        super(message)
        this.step = step
        this.args = args
    }
}
export class EventPipelineRunner {
    hub: Hub
    originalEvent: PipelineEvent

    // See https://docs.google.com/document/d/12Q1KcJ41TicIwySCfNJV5ZPKXWVtxT7pzpB3r9ivz_0
    poEEmbraceJoin: boolean

    constructor(hub: Hub, event: PipelineEvent, poEEmbraceJoin = false) {
        this.hub = hub
        this.poEEmbraceJoin = poEEmbraceJoin
        this.originalEvent = event
    }

    isEventDisallowed(event: PipelineEvent): boolean {
        // During incidents we can use the the env DROP_EVENTS_BY_TOKEN_DISTINCT_ID
        // to drop events here before processing them which would allow us to catch up
        const key = event.token || event.team_id?.toString()
        if (!key) {
            return false // for safety don't drop events here, they are later dropped in teamDataPopulation
        }
        const dropIds = this.hub.eventsToDropByToken?.get(key)
        return dropIds?.includes(event.distinct_id) || dropIds?.includes('*') || false
    }

    async runEventPipeline(event: PipelineEvent): Promise<EventPipelineResult> {
        this.originalEvent = event

        try {
            if (this.isEventDisallowed(event)) {
                eventDroppedCounter
                    .labels({
                        event_type: 'analytics',
                        drop_cause: 'disallowed',
                    })
                    .inc()
                return this.registerLastStep('eventDisallowedStep', [event])
            }
            let result: EventPipelineResult
            const eventWithTeam = await this.runStep(populateTeamDataStep, [this, event], event.team_id || -1)
            if (eventWithTeam != null) {
                result = await this.runEventPipelineSteps(eventWithTeam)
            } else {
                result = this.registerLastStep('populateTeamDataStep', [event])
            }
            eventProcessedAndIngestedCounter.inc()
            return result
        } catch (error) {
            if (error instanceof StepErrorNoRetry) {
                // At the step level we have chosen to drop these events and send them to DLQ
                return { lastStep: error.step, args: [], error: error.message }
            } else {
                // Otherwise rethrow, which leads to Kafka offsets not getting committed and retries
                Sentry.captureException(error, {
                    tags: { pipeline_step: 'outside' },
                    extra: { originalEvent: this.originalEvent },
                })
                throw error
            }
        }
    }

    async runEventPipelineSteps(event: PluginEvent): Promise<EventPipelineResult> {
        if (
            this.hub.poeEmbraceJoinForTeams?.(event.team_id) ||
            (event.team_id <= this.hub.POE_WRITES_ENABLED_MAX_TEAM_ID && !this.hub.poeWritesExcludeTeams(event.team_id))
        ) {
            // https://docs.google.com/document/d/12Q1KcJ41TicIwySCfNJV5ZPKXWVtxT7pzpB3r9ivz_0
            // We're not using the buffer anymore
            // instead we'll (if within timeframe) merge into the newer personId

            // TODO: remove this step and runner env once we're confident that the new
            // ingestion pipeline is working well for all teams.
            this.poEEmbraceJoin = true
        }

        const kafkaAcks: Promise<void>[] = []

        let processPerson = true // The default.
        if (event.properties && '$process_person' in event.properties) {
            const propValue = event.properties.$process_person
            if (propValue === true) {
                // This is the default, and `true` is one of the two valid values.
            } else if (propValue === false) {
                // Only a boolean `false` disables person processing.
                processPerson = false

                if (['$identify', '$create_alias', '$merge_dangerously', '$groupidentify'].includes(event.event)) {
                    kafkaAcks.push(
                        captureIngestionWarning(
                            this.hub.db.kafkaProducer,
                            event.team_id,
                            'invalid_event_when_process_person_is_false',
                            {
                                eventUuid: event.uuid,
                                event: event.event,
                                distinctId: event.distinct_id,
                            },
                            { alwaysSend: true }
                        )
                    )

                    return this.registerLastStep('invalidEventForProvidedFlags', [event], kafkaAcks)
                }

                // If person processing is disabled, go ahead and remove person related keys before
                // any plugins have a chance to see them.
                event = normalizeProcessPerson(event, processPerson)
            } else {
                // Anything other than `true` or `false` is invalid, and the default (true) will be
                // used.
                kafkaAcks.push(
                    captureIngestionWarning(
                        this.hub.db.kafkaProducer,
                        event.team_id,
                        'invalid_process_person',
                        {
                            eventUuid: event.uuid,
                            event: event.event,
                            distinctId: event.distinct_id,
                            $process_person: propValue,
                            message: 'Only a boolean value is valid for the $process_person property',
                        },
                        { alwaysSend: false }
                    )
                )
            }
        }

        if (event.event === '$$client_ingestion_warning') {
            kafkaAcks.push(
                captureIngestionWarning(
                    this.hub.db.kafkaProducer,
                    event.team_id,
                    'client_ingestion_warning',
                    {
                        eventUuid: event.uuid,
                        event: event.event,
                        distinctId: event.distinct_id,
                        message: event.properties?.$$client_ingestion_warning_message,
                    },
                    { alwaysSend: true }
                )
            )

            return this.registerLastStep('clientIngestionWarning', [event], kafkaAcks)
        }

        // Some expensive, deprecated plugins are skipped when `$process_person=false`
        const runDeprecatedPlugins = processPerson
        const processedEvent = await this.runStep(
            pluginsProcessEventStep,
            [this, event, runDeprecatedPlugins],
            event.team_id
        )

        if (processedEvent == null) {
            // A plugin dropped the event.
            return this.registerLastStep('pluginsProcessEventStep', [event], kafkaAcks)
        }

        const [normalizedEvent, timestamp] = await this.runStep(
            normalizeEventStep,
            [processedEvent, processPerson],
            event.team_id
        )

        const [postPersonEvent, person] = await this.runStep(
            processPersonsStep,
            [this, normalizedEvent, timestamp, processPerson],
            event.team_id
        )

        const preparedEvent = await this.runStep(
            prepareEventStep,
            [this, postPersonEvent, processPerson],
            event.team_id
        )

        const [rawClickhouseEvent, eventAck] = await this.runStep(
            createEventStep,
            [this, preparedEvent, person, processPerson],
            event.team_id
        )

        kafkaAcks.push(eventAck)
        return this.registerLastStep('createEventStep', [rawClickhouseEvent], kafkaAcks)
    }

    registerLastStep(stepName: string, args: any[], ackPromises?: Array<Promise<void>>): EventPipelineResult {
        pipelineLastStepCounter.labels(stepName).inc()
        return { ackPromises, lastStep: stepName, args }
    }

    protected runStep<Step extends (...args: any[]) => any>(
        step: Step,
        args: Parameters<Step>,
        teamId: number,
        sentToDql = true
    ): ReturnType<Step> {
        const timer = new Date()
        return runInSpan(
            {
                op: 'runStep',
                description: step.name,
            },
            async () => {
                const sendToSentry = false
                const timeout = timeoutGuard(
                    `Event pipeline step stalled. Timeout warning after ${this.hub.PIPELINE_STEP_STALLED_LOG_TIMEOUT} sec! step=${step.name} team_id=${teamId} distinct_id=${this.originalEvent.distinct_id}`,
                    () => ({
                        step: step.name,
                        event: JSON.stringify(this.originalEvent),
                        teamId: teamId,
                        distinctId: this.originalEvent.distinct_id,
                    }),
                    this.hub.PIPELINE_STEP_STALLED_LOG_TIMEOUT * 1000,
                    sendToSentry
                )
                try {
                    const result = await step(...args)
                    pipelineStepMsSummary.labels(step.name).observe(Date.now() - timer.getTime())
                    return result
                } catch (err) {
                    await this.handleError(err, step.name, args, teamId, sentToDql)
                } finally {
                    clearTimeout(timeout)
                }
            }
        )
    }

    private shouldRetry(err: any): boolean {
        if (err instanceof DependencyUnavailableError) {
            // If this is an error with a dependency that we control, we want to
            // ensure that the caller knows that the event was not processed,
            // for a reason that we control and that is transient.
            return true
        }
        // TODO: Disallow via env of errors we're going to put into DLQ instead of taking Kafka lag
        return false
    }

    private async handleError(err: any, currentStepName: string, currentArgs: any, teamId: number, sentToDql: boolean) {
        status.error('🔔', 'step_failed', { currentStepName, err })
        Sentry.captureException(err, {
            tags: { team_id: teamId, pipeline_step: currentStepName },
            extra: { currentArgs, originalEvent: this.originalEvent },
        })

        pipelineStepErrorCounter.labels(currentStepName).inc()

        // Should we throw or should we drop and send the event to DLQ.
        if (this.shouldRetry(err)) {
            pipelineStepThrowCounter.labels(currentStepName).inc()
            throw err
        }

        if (sentToDql) {
            pipelineStepDLQCounter.labels(currentStepName).inc()
            try {
                const message = generateEventDeadLetterQueueMessage(
                    this.originalEvent,
                    err,
                    teamId,
                    `plugin_server_ingest_event:${currentStepName}`
                )
                await this.hub.db.kafkaProducer!.queueMessage({ kafkaMessage: message, waitForAck: true })
            } catch (dlqError) {
                status.info('🔔', `Errored trying to add event to dead letter queue. Error: ${dlqError}`)
                Sentry.captureException(dlqError, {
                    tags: { team_id: teamId },
                    extra: { currentStepName, currentArgs, originalEvent: this.originalEvent, err },
                })
            }
        }

        // These errors are dropped rather than retried
        throw new StepErrorNoRetry(currentStepName, currentArgs, err.message)
    }
}
