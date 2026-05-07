// Bilingual (USD + EUR) invoice for Non-EU clients (OverseasClientCo regular paychecks
// + reimbursements + bonuses). Single template covers the single-line and
// multi-line cases — `lines` is iterated.
//
// Data is loaded from `data.json` in the same directory at compile time.

#let data = json("data.json")

#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm))
#set text(size: 11pt)
#set par(justify: false, leading: 0.65em)

// Issuer header — right-aligned, plain.
#align(right)[
  #data.issuer.name \
  #data.issuer.addressLine1 \
  #data.issuer.postalCode #data.issuer.city \
  #data.issuer.country \
  Kvk: #data.issuer.kvk \
  VAT: #data.issuer.vatId
]

#v(1.5em)

// Recipient
*Per email:*

#data.client.name \
#data.client.addressLine1 \
#data.client.city

#v(1em)

Date: #data.invoice.dateFormatted

#v(0.5em)

*Invoice number:* #data.invoice.number

#v(1em)

*Description:*

#v(0.5em)

#for line in data.lines [
  #grid(
    columns: (1fr, auto, auto),
    column-gutter: 1em,
    align: (left, right, right),
    [#emph(line.description)],
    [\$#line.usdAmount],
    [(€#line.eurAmount)],
  )
]

#v(1em)
#line(length: 100%, stroke: 0.5pt)
#v(0.5em)

#grid(
  columns: (1fr, auto, auto),
  column-gutter: 1em,
  align: (left, right, right),
  [*Amount*],
  [*\$#data.invoice.totalUsd*],
  [(€#data.invoice.totalEur)],
)

#v(1.5em)

NO VAT because non EU
