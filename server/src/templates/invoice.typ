// Single invoice template covering all client classes:
//   - "domestic" / "eu" → Dutch BTW breakdown, IBAN payment block.
//   - "eu_reverse_charge" → no BTW, "VAT reverse-charged" footer.
//   - "non_eu" → bilingual USD+EUR (or EUR-only) totals, no VAT, no payment.
//
// `data.invoice.class` selects the variant. The composer pre-formats every
// numeric field so the template doesn't reason about money.
//
// Data is loaded from `data.json` co-located with this file at compile time.

#let data = json("data.json")

#let accent = rgb("#0b3d6b")
#let muted = rgb("#666666")
#let rule-color = rgb("#cfd6df")

#let cls = data.invoice.class
#let is-non-eu = cls == "non_eu"
#let is-reverse-charge = cls == "eu_reverse_charge"
#let has-btw = not (is-non-eu or is-reverse-charge)
#let has-payment = not is-non-eu

// Currency-aware amount renderer for non-EU lines/totals. USD invoices show
// the dollar value with the EUR equivalent in parens; EUR-only invoices
// (e.g. FOSDEM reimbursements) just show the EUR figure.
#let format-amount(line) = if data.invoice.currency == "USD" [
  \$ #line.usdAmount #text(fill: muted, style: "italic")[(€ #line.eurAmount)]
] else [
  € #line.eurAmount
]

#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm))
// Liberation Sans is a metric-compatible Arial substitute and ships with the
// typst container; real Arial/Helvetica wins when the renderer has them.
#set text(size: 11pt, font: ("Arial", "Liberation Sans", "DejaVu Sans"))
#set par(justify: false, leading: 0.65em)
#show link: it => text(fill: rgb("#1155cc"), underline(it))

// Issuer header — right-aligned, name bold + rest muted.
#align(right)[
  #text(weight: "bold", size: 12pt, data.issuer.name) \
  #text(fill: muted)[
    #data.issuer.addressLine1 \
    #data.issuer.postalCode #data.issuer.city \
    #data.issuer.country \
    Kvk: #data.issuer.kvk \
    VAT: #data.issuer.vatId
  ]
]

#v(0.5em)
#line(length: 100%, stroke: 0.6pt + rule-color)
#v(1em)

#grid(
  columns: (1fr, auto),
  column-gutter: 2em,
  align: (left, right),
  [
    #text(fill: accent, weight: "bold", size: 9pt, upper("Via email"))
    #v(0.3em)
    #data.client.name \
    #data.client.addressLine1 \
    #data.client.city
  ],
  [
    #text(fill: accent, weight: "bold", size: 9pt, upper("Invoice"))
    #v(0.3em)
    *#data.invoice.number* \
    #text(fill: muted, data.invoice.dateFormatted)
  ],
)

#v(1.5em)

// Line items.
#if has-btw [
  // BTW breakdown wants per-line unit + quantity + total in € (Dutch format).
  #table(
    columns: (1fr, auto, auto, auto),
    align: (left, right, right, right),
    inset: (x: 6pt, y: 7pt),
    stroke: none,
    fill: (_, y) => if y == 0 { accent } else if calc.odd(y) { rgb("#f4f6fa") } else { none },
    table.header(
      text(fill: white, weight: "bold")[Description],
      text(fill: white, weight: "bold")[Unit],
      text(fill: white, weight: "bold")[Amount],
      text(fill: white, weight: "bold")[Total],
    ),
    ..data.lines.map(line => (
      [#emph(line.description)],
      [#line.unit],
      [#line.quantity],
      [€ #line.total],
    )).flatten()
  )
] else [
  // Non-EU and reverse-charge: simple description + amount per line.
  #text(fill: accent, weight: "bold", size: 9pt, upper("Description"))
  #v(0.6em)
  #for line in data.lines [
    #grid(
      columns: (1fr, auto),
      column-gutter: 1em,
      align: (left, right),
      [#emph(line.description)],
      format-amount(line),
    )
    #v(0.4em)
  ]
]

#v(1em)

// Totals area.
#if has-btw [
  #grid(
    columns: (1fr, auto, auto),
    column-gutter: 1em,
    row-gutter: 0.6em,
    align: (left, right, right),
    [Subtotal], [], [€ #data.invoice.subtotal],
    [BTW], [#data.invoice.btwRate], [€ #data.invoice.btwAmount],
  )
  #v(0.5em)
  #line(length: 100%, stroke: 1pt + accent)
  #v(0.4em)
  #grid(
    columns: (1fr, auto),
    column-gutter: 1em,
    align: (left, right),
    text(weight: "bold", size: 13pt, fill: accent)[Total],
    text(weight: "bold", size: 13pt, fill: accent)[€ #data.invoice.total],
  )
] else [
  #line(length: 100%, stroke: 1pt + accent)
  #v(0.4em)
  #grid(
    columns: (1fr, auto),
    column-gutter: 1em,
    align: (left, right),
    text(weight: "bold", size: 13pt, fill: accent)[Amount],
    text(weight: "bold", size: 13pt, fill: accent, format-amount(data.invoice.totalLine)),
  )
]

#v(1.5em)

// Footer notes per class.
#if is-non-eu [
  #text(fill: muted, style: "italic")[NO VAT because non EU]
] else if is-reverse-charge [
  #text(fill: muted, style: "italic")[VAT reverse-charged (intra-EU services, customer accounts for VAT)]
]

// Payment block — only on EUR-paid invoices.
#if has-payment [
  #v(2em)
  #text(fill: accent, weight: "bold", size: 9pt, upper("Payment to"))
  #v(0.4em)
  #grid(
    columns: (auto, 1fr),
    column-gutter: 2em,
    row-gutter: 0.5em,
    [IBAN number:], [#data.payment.iban],
    [Name:], [#data.payment.name],
  )
  #if "paymentLink" in data.payment [
    #v(0.6em)
    Or via #link(data.payment.paymentLink)
  ]
]
