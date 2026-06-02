# ADR 0001: Use a Single Extension Workbench Around a Product Queue

## Status

Accepted

## Context

The existing tools split the workflow across a T2 spreadsheet processor, a local preview HTML bridge, a 1688 pricing extension, and a ChatGPT image automation extension. This makes state hard to preserve and couples user workflow to temporary files.

## Decision

Build the combined tool as one Chrome extension workbench whose central concept is a durable product queue. Spreadsheet import, 1688 extraction, pricing, image generation, and export are independent adapters or use cases around that queue.

## Consequences

- The user gets one primary entry point.
- Business rules become testable without browser automation.
- ChatGPT and 1688 page changes are isolated to adapters.
- The old `result.html` bridge can be retired after import writes directly to the queue.
