# System design: the originals
id: design-reading
blurb: Articles by the engineers who run large systems: Amazon's Builders' Library, Google's SRE book, Azure's cloud patterns and Martin Fowler.
why: Human-written sources for the ideas every system design interview and real design leans on. Turn on Type the docs to type each one.
stage: reliability | Measuring reliability | Say how reliable a system must be, and see when it isn't.
stage: traffic | Spreading the load | Balance, cache, shard and limit traffic.
stage: failure | Surviving failure | Keep one failure from becoming an outage.
stage: data | Data and agreement | Keep data right when many machines and retries are involved.
stage: shape | The shape of a system | Split a system into services and connect them with queues.

## Service level objectives
id: service-level-objectives
stage: reliability
minutes: 100
source: Service level objectives | https://sre.google/sre-book/service-level-objectives/

From *Site Reliability Engineering* (Google, O'Reilly 2016), free to read at sre.google. About 3,482 words.

## Monitoring distributed systems
id: monitoring-distributed-systems
stage: reliability
minutes: 125
source: Monitoring distributed systems | https://sre.google/sre-book/monitoring-distributed-systems/

From *Site Reliability Engineering* (Google, O'Reilly 2016), free to read at sre.google. About 4,404 words.

## Challenges with distributed systems
id: challenges-with-distributed-systems
stage: reliability
minutes: 120
source: Challenges with distributed systems | https://aws.amazon.com/builders-library/challenges-with-distributed-systems/

From the Amazon Builders' Library, written by the engineers who run the systems. About 4,224 words.

## Load balancing at the frontend
id: load-balancing-at-the-frontend
stage: traffic
minutes: 75
source: Load balancing at the frontend | https://sre.google/sre-book/load-balancing-frontend/

From *Site Reliability Engineering* (Google, O'Reilly 2016), free to read at sre.google. About 2,657 words.

## Load balancing in the datacenter
id: load-balancing-in-the-datacenter
stage: traffic
minutes: 150
source: Load balancing in the datacenter | https://sre.google/sre-book/load-balancing-datacenter/

From *Site Reliability Engineering* (Google, O'Reilly 2016), free to read at sre.google. About 5,284 words.

## Caching challenges and strategies
id: caching-challenges-and-strategies
stage: traffic
minutes: 100
source: Caching challenges and strategies | https://aws.amazon.com/builders-library/caching-challenges-and-strategies/

From the Amazon Builders' Library, written by the engineers who run the systems. About 3,447 words.

## Cache-Aside pattern
id: cache-aside-pattern
stage: traffic
minutes: 55
source: Cache-Aside pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside

From the Azure Architecture Center's catalogue of cloud design patterns. About 1,874 words.

## Sharding pattern
id: sharding-pattern
stage: traffic
minutes: 140
source: Sharding pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/sharding

From the Azure Architecture Center's catalogue of cloud design patterns. About 4,920 words.

## Rate Limiting pattern
id: rate-limiting-pattern
stage: traffic
minutes: 90
source: Rate Limiting pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/rate-limiting-pattern

From the Azure Architecture Center's catalogue of cloud design patterns. About 3,073 words.

## Timeouts, retries and backoff with jitter
id: timeouts-retries-and-backoff-with-jitter
stage: failure
minutes: 65
source: Timeouts, retries and backoff with jitter | https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/

From the Amazon Builders' Library, written by the engineers who run the systems. About 2,306 words.

## Retry pattern
id: retry-pattern
stage: failure
minutes: 50
source: Retry pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/retry

From the Azure Architecture Center's catalogue of cloud design patterns. About 1,689 words.

## Circuit Breaker pattern
id: circuit-breaker-pattern
stage: failure
minutes: 100
source: Circuit Breaker pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker

From the Azure Architecture Center's catalogue of cloud design patterns. About 3,476 words.

## Bulkhead pattern
id: bulkhead-pattern
stage: failure
minutes: 35
source: Bulkhead pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead

From the Azure Architecture Center's catalogue of cloud design patterns. About 1,176 words.

## Handling overload
id: handling-overload
stage: failure
minutes: 130
source: Handling overload | https://sre.google/sre-book/handling-overload/

From *Site Reliability Engineering* (Google, O'Reilly 2016), free to read at sre.google. About 4,596 words.

## Addressing cascading failures
id: addressing-cascading-failures
stage: failure
minutes: 255
source: Addressing cascading failures | https://sre.google/sre-book/addressing-cascading-failures/

From *Site Reliability Engineering* (Google, O'Reilly 2016), free to read at sre.google. About 8,968 words.

## Using load shedding to avoid overload
id: using-load-shedding-to-avoid-overload
stage: failure
minutes: 160
source: Using load shedding to avoid overload | https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/

From the Amazon Builders' Library, written by the engineers who run the systems. About 5,537 words.

## Avoiding insurmountable queue backlogs
id: avoiding-insurmountable-queue-backlogs
stage: failure
minutes: 145
source: Avoiding insurmountable queue backlogs | https://aws.amazon.com/builders-library/avoiding-insurmountable-queue-backlogs/

From the Amazon Builders' Library, written by the engineers who run the systems. About 5,041 words.

## Workload isolation using shuffle-sharding
id: workload-isolation-using-shuffle-shardin
stage: failure
minutes: 55
source: Workload isolation using shuffle-sharding | https://aws.amazon.com/builders-library/workload-isolation-using-shuffle-sharding/

From the Amazon Builders' Library, written by the engineers who run the systems. About 1,885 words.

## Making retries safe with idempotent APIs
id: making-retries-safe-with-idempotent-apis
stage: data
minutes: 90
source: Making retries safe with idempotent APIs | https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/

From the Amazon Builders' Library, written by the engineers who run the systems. About 3,099 words.

## Leader election in distributed systems
id: leader-election-in-distributed-systems
stage: data
minutes: 55
source: Leader election in distributed systems | https://aws.amazon.com/builders-library/leader-election-in-distributed-systems/

From the Amazon Builders' Library, written by the engineers who run the systems. About 1,980 words.

## Managing critical state: distributed consensus
id: managing-critical-state-distributed-cons
stage: data
minutes: 270
source: Managing critical state: distributed consensus | https://sre.google/sre-book/managing-critical-state/

From *Site Reliability Engineering* (Google, O'Reilly 2016), free to read at sre.google. About 9,474 words.

## CQRS
id: cqrs
stage: data
minutes: 35
source: CQRS | https://martinfowler.com/bliki/CQRS.html

By Martin Fowler. About 1,195 words.

## CQRS pattern
id: cqrs-pattern
stage: data
minutes: 70
source: CQRS pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs

From the Azure Architecture Center's catalogue of cloud design patterns. About 2,523 words.

## Event Sourcing
id: event-sourcing
stage: data
minutes: 175
source: Event Sourcing | https://martinfowler.com/eaaDev/EventSourcing.html

By Martin Fowler. About 6,164 words.

## Event Sourcing pattern
id: event-sourcing-pattern
stage: data
minutes: 120
source: Event Sourcing pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing

From the Azure Architecture Center's catalogue of cloud design patterns. About 4,232 words.

## Saga pattern
id: saga-pattern
stage: data
minutes: 35
source: Saga pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/saga

From the Azure Architecture Center's catalogue of cloud design patterns. About 1,308 words.

## Microservices
id: microservices
stage: shape
minutes: 155
source: Microservices | https://martinfowler.com/articles/microservices.html

By James Lewis and Martin Fowler. About 5,385 words.

## Strangler Fig pattern
id: strangler-fig-pattern
stage: shape
minutes: 50
source: Strangler Fig pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig

From the Azure Architecture Center's catalogue of cloud design patterns. About 1,812 words.

## Queue-Based Load Leveling pattern
id: queue-based-load-leveling-pattern
stage: shape
minutes: 45
source: Queue-Based Load Leveling pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling

From the Azure Architecture Center's catalogue of cloud design patterns. About 1,638 words.

## Competing Consumers pattern
id: competing-consumers-pattern
stage: shape
minutes: 50
source: Competing Consumers pattern | https://learn.microsoft.com/en-us/azure/architecture/patterns/competing-consumers

From the Azure Architecture Center's catalogue of cloud design patterns. About 1,674 words.
