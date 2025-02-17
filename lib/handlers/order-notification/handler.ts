import axios, { AxiosResponse } from 'axios'
import Joi from 'joi'
import { metrics } from '../../util/metrics'
import { eventRecordToOrder } from '../../util/order'
import { BatchFailureResponse, DynamoStreamLambdaHandler } from '../base/dynamo-stream-handler'
import { ContainerInjected, RequestInjected } from './injector'
import { OrderNotificationInputJoi } from './schema'

const WEBHOOK_TIMEOUT_MS = 500

export class OrderNotificationHandler extends DynamoStreamLambdaHandler<ContainerInjected, RequestInjected> {
  public async handleRequest(input: {
    containerInjected: ContainerInjected
    requestInjected: RequestInjected
  }): Promise<BatchFailureResponse> {
    const {
      requestInjected: { log, event },
      containerInjected: { webhookProvider },
    } = input

    const failedRecords = []
    for (const record of event.Records) {
      try {
        const newOrder = eventRecordToOrder(record)

        const registeredEndpoints = await webhookProvider.getEndpoints({
          offerer: newOrder.swapper,
          orderStatus: newOrder.orderStatus,
          filler: newOrder.filler,
        })

        log.info({ order: newOrder, registeredEndpoints }, 'Sending order to registered webhooks.')

        const requests: Promise<AxiosResponse>[] = registeredEndpoints.map((endpoint) =>
          axios.post(
            endpoint.url,
            {
              orderHash: newOrder.orderHash,
              createdAt: newOrder.createdAt,
              signature: newOrder.signature,
              offerer: newOrder.swapper,
              orderStatus: newOrder.orderStatus,
              encodedOrder: newOrder.encodedOrder,
              chainId: newOrder.chainId,
              ...(newOrder.quoteId && { quoteId: newOrder.quoteId }),
              ...(newOrder.filler && { filler: newOrder.filler }),
            },
            {
              timeout: WEBHOOK_TIMEOUT_MS,
              headers: { ...endpoint.headers },
            }
          )
        )

        // send all notifications and track the failed requests
        // note we try each webhook once and only once, so guarantee to MM is _at most once_
        const failedRequests: PromiseSettledResult<AxiosResponse>[] = []
        const results = await Promise.allSettled(requests)

        results.forEach((result, index) => {
          metrics.putMetric(`OrderNotificationAttempt-chain-${newOrder.chainId}`, 1)
          if (result.status == 'fulfilled' && result?.value?.status >= 200 && result?.value?.status <= 202) {
            delete result.value.request
            log.info(
              { result: result.value },
              `Success: New order record sent to registered webhook ${registeredEndpoints[index].url}.`
            )
            metrics.putMetric(`OrderNotificationSendSuccess-chain-${newOrder.chainId}`, 1)
          } else {
            failedRequests.push(result)
            metrics.putMetric(`OrderNotificationSendFailure-chain-${newOrder.chainId}`, 1)
          }
        })

        if (failedRequests.length > 0) {
          log.error({ failedRequests: failedRequests }, 'Error: Failed to notify registered webhooks.')
          failedRecords.push({ itemIdentifier: record.dynamodb?.SequenceNumber })
        }
      } catch (e: unknown) {
        log.error(e instanceof Error ? e.message : e, 'Unexpected failure in handler.')
        failedRecords.push({ itemIdentifier: record.dynamodb?.SequenceNumber })
        metrics.putMetric('OrderNotificationHandlerFailure', 1)
      }
    }

    // this lambda will be invoked again with the failed records
    return { batchItemFailures: failedRecords }
  }

  protected inputSchema(): Joi.ObjectSchema | null {
    return OrderNotificationInputJoi
  }
}
