# MunchMate (local demo)

A runnable local version of the MunchMate architecture: microservices + event-driven.

## Run it
1. Install Node.js 18 or newer from https://nodejs.org (no other installs needed).
2. Open a terminal in this folder and run: `node server.js`
3. Open http://localhost:3000 in your browser.

## What you can do
- **Front page:** enter your name and press "Order now".
- **Menu and cart:** add items, then press **Place order**.
- **My order page:** live status (Placed, Accepted, Preparing, Rider assigned, On the way, Delivered), rider, notifications, timeline and receipt. It updates by itself.
- **Behind the scenes panel:** live log of every service, SNS/SQS queue and Lambda, plus queue sizes and cache hits.

## How it maps to the architecture diagram
| Diagram | In this app |
|---|---|
| API Gateway + auth | HTTP gateway: login token, rate limiting, routing |
| Users, Catalog, Orders, Payments, Delivery | Separate service modules, each with its own data store |
| Redis cache | In-memory cache with TTL (cache-aside for the menu) |
| SNS topic + SQS queues | Event bus with queues: delivery, jobs, notify, orders-status |
| Retries + dead-letter queue | A failing message retries 3 times, then moves to the DLQ |
| Lambda: notify / jobs | Queue consumers that send notifications and save receipts |
| Real-time updates | Server-sent events push status to the page |

## Demo failure handling (matches the "if a component fails" slide)
Use the **Break ...** buttons in the side panel:
- **Break Notifications:** place an order. It still works; notification messages wait in the queue and arrive after you press Restore.
- **Break Delivery:** order is accepted and paid, but the rider steps pause until restore.
- **Break Payments:** the order stays PENDING and you see a clear error.
- **Break Redis cache:** menu still loads, straight from the catalog database.

Note: this is a single-process simulation for learning. In the real design, each service would be its own container and the queues would be AWS SNS/SQS.
