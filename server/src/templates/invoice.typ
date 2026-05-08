// Invoice template — generic. Composer hands us:
//   - issuer, client: header blocks (right + left)
//   - invoice: { number, dateFormatted }
//   - table: { headers[], aligns[], rows[][] } (each row's first cell gets
//     italic emphasis by convention)
//   - summary: [{ label, value, emphasised? }] rendered after the table
//   - footer (optional): trailing note like "NO VAT because non EU"
//   - payment (optional): { iban, name, paymentLink? } for EUR-paid invoices
//
// Per-class differences live entirely in the composer; this file just
// renders whatever shape it's handed.

#let data = json("data.json")

#let accent = rgb("#0b3d6b")
#let muted = rgb("#666666")
#let rule-color = rgb("#cfd6df")

#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm))
// Liberation Sans is metric-compatible with Arial and ships on the runtime
// container; real Arial wins where the renderer has it.
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

// Line items — column count + alignment + cell content all from the composer.
// Convention: first column is the description and gets italic emphasis.
#table(
  columns: data.table.headers.map(_ => auto).slice(0, data.table.headers.len() - 1) + (1fr,),
  align: data.table.aligns.map(a => if a == "right" { right } else { left }),
  inset: (x: 6pt, y: 7pt),
  stroke: none,
  fill: (_, y) => if y == 0 { accent } else if calc.odd(y) { rgb("#f4f6fa") } else { none },
  table.header(..data.table.headers.map(h => text(fill: white, weight: "bold")[#h])),
  ..data.table.rows.map(row => row.enumerate().map(((i, cell)) => if i == 0 { emph(cell) } else { [#cell] })).flatten()
)

#v(1em)

// Summary — last entry usually `emphasised: true` and renders as the big
// total. Earlier entries are plain right-aligned label/value rows.
#for (i, item) in data.summary.enumerate() [
  #if item.at("emphasised", default: false) [
    #v(0.3em)
    #line(length: 100%, stroke: 1pt + accent)
    #v(0.4em)
    #grid(
      columns: (1fr, auto),
      align: (left, right),
      text(weight: "bold", size: 13pt, fill: accent)[#item.label],
      text(weight: "bold", size: 13pt, fill: accent)[#item.value],
    )
  ] else [
    #grid(
      columns: (1fr, auto),
      align: (left, right),
      [#item.label],
      [#item.value],
    )
    #v(0.4em)
  ]
]

#if "footer" in data [
  #v(1.5em)
  #text(fill: muted, style: "italic")[#data.footer]
]

#if "payment" in data [
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
