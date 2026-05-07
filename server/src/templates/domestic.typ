// Domestic / EU invoice with Dutch BTW. Multi-line table with per-line unit
// price + quantity + line total, subtotal/BTW/total breakdown, and payment
// instructions (IBAN + optional betaalverzoek URL).
//
// Data is loaded from `data.json` co-located with this file at compile time.

#let data = json("data.json")

#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm))
#set text(size: 11pt)
#set par(justify: false, leading: 0.65em)

// Issuer header — right-aligned.
#align(right)[
  #data.issuer.name \
  #data.issuer.addressLine1 \
  #data.issuer.postalCode #data.issuer.city \
  #data.issuer.country \
  Kvk: #data.issuer.kvk \
  VAT: #data.issuer.vatId
]

#v(1.5em)

*Per email:*

#data.client.name \
#data.client.addressLine1 \
#data.client.city

#v(1em)

#data.invoice.dateFormatted

#v(0.5em)

*Invoice number:* #data.invoice.number

#v(1em)

#table(
  columns: (1fr, auto, auto, auto),
  align: (left, right, right, right),
  inset: (x: 6pt, y: 6pt),
  stroke: none,
  table.header(
    [*Description*],
    [*Unit*],
    [*Amount*],
    [*Total*],
  ),
  ..data.lines.map(line => (
    [#emph(line.description)],
    [#line.unit],
    [#line.quantity],
    [€ #line.total],
  )).flatten()
)

#v(1em)
#line(length: 100%, stroke: 0.5pt)
#v(0.5em)

#grid(
  columns: (1fr, auto),
  column-gutter: 1em,
  align: (left, right),
  [*Subtotal*],
  [€ #data.invoice.subtotal],
)

#v(0.5em)

#grid(
  columns: (1fr, auto, auto),
  column-gutter: 1em,
  align: (left, right, right),
  [*BTW*],
  [#data.invoice.btwRate],
  [€ #data.invoice.btwAmount],
)

#v(0.5em)
#line(length: 100%, stroke: 0.5pt)
#v(0.5em)

#grid(
  columns: (1fr, auto),
  column-gutter: 1em,
  align: (left, right),
  [*Total*],
  [*€ #data.invoice.total*],
)

#v(2em)

*Payment to:*

IBAN: #data.payment.iban \
Name: #data.payment.name

#if "paymentLink" in data.payment [
  #v(0.5em)
  Or via #link(data.payment.paymentLink)
]
