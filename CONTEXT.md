# Context

## Terms

- **Product**: A single sellable item being prepared for Temu listing work. It is identified by an internal `id` and normally carries a `skc`.
- **SKC**: The shared matching key between the T2 information sheet and the price sheet. Import logic deduplicates by SKC and only keeps products present in both sheets.
- **T2 information sheet**: The source spreadsheet containing product name, product image URL, and SKC.
- **T2 price sheet**: The source spreadsheet containing SKC and adjusted declared price. When multiple price rows share an SKC, import keeps the maximum adjusted declared price for the deduped product intersection and exposes the duplicate rows for audit export.
- **T2 JSON continuation file**: A local JSON array that can be appended from the 1688 pricing page after products are selected from the collection list. Incoming T2 records are merged by SKC so rerunning a batch updates the same SKC instead of creating another copy.
- **Product collection list**: A temporary local collection of products sent from the T2 preview page. The 1688 pricing page is responsible for choosing which collected products to load into the form or append into JSON.
- **Product queue**: The durable list of products being processed. Import, 1688 enrichment, pricing, ChatGPT image generation, and export operate on this queue.
- **1688 enrichment**: The step that reads the current 1688 product page and fills source URL, goods price, shipping fee, unit price, and weight.
- **Pricing**: The pure business calculation that converts declared price, 1688 cost, weight, quantity, discount rate, and fee configuration into profit, ROI, and margin.

## Rules

- Domain code must not depend on Chrome APIs, DOM APIs, Excel libraries, or ChatGPT page selectors.
- Site automation and file formats are adapters. They return domain data; they do not own workflow state.
- The product queue is the system of record during a batch.
