# Water Monitor

A read-only device for the home's water: how many litres were used today and this month, what
they cost, and each use of water as it happens. It reads the house water meter and switches nothing.

## Add it

Add device → Adaptive Home Comfort → **Water Monitor**, then choose the **House water meter**: a
device of any app with Homey's standard **Water meter** (`meter_water`, m³) and/or **Water flow**
(`measure_water`, l/min). A flow as `measure_water_flow` in l/min works too, as some water meter
apps (for example Aquaro) report it.

- With both, the litres come from the meter reading and the uses from the flow.
- With the meter reading only, the litres are counted but there are no uses.
- With the flow only, the litres are counted from the flow.

Then tick the **Water uses** the home has: **Shower**, **Tap / sink**, **Toilet**, **Bath** and
**Outdoor tap** (they need a meter with a flow). See [Categories](#categories).

Pick another meter or change the water uses in the device's **Repair**. Today's and this month's
litres are kept.

## What it shows

- **Water today** (l) and **Water this month** (m³). They start from zero at midnight and on the
  first day of the month.
- **Water cost today** and **Water cost this month**, when a [water price or base fee](#settings)
  is set.
- **Flow** now (l/min).
- **Last use**: the use going on (*Running since 07:42 - 12 l*) or the last one
  (*07:42 - 07:47, 38 l at 7.6 l/min*).

## Settings

- **Water price** (per m³): supply and wastewater together, as on the water bill (with VAT if you
  pay it). The litres are counted at this price, so a new price applies to the whole month.
- **Base fee** (per month): the bill's fixed fee, spread evenly over the month's days. Today's
  cost has one day's share; this month's cost has the shares of the days so far.

Both are in the Home Controller's currency; 0 leaves them out. A use's cost (**Water use ended**)
is its litres at the water price, without the base fee.

## Uses

A use starts when water starts running and ends a minute after it stops: a short pause in a
shower is still the same shower, while a washing machine's fills a few minutes apart are separate
uses.

Some meters report a small flow while no water passes, for example an ultrasonic meter some time
after a use. So a use counts only once the meter reading has moved by a litre: **Water use
started** runs then, and a flow that ends before that is ignored. A meter with only a flow can't be
checked like this; its uses count as soon as the flow rises.

The meter sees all the home's water, so two uses at the same time (a tap while a shower runs)
count as one.

## Categories

Each use is counted in one of the ticked water uses by its litres, length and flow:

| Category | Pattern |
| --- | --- |
| Bath | 80 l or more at over 10 l/min |
| Outdoor tap | 30 minutes or more, or 10 minutes or more at over 12 l/min |
| Shower | 3 minutes or more at 4-13 l/min |
| Toilet | 3-10 l in under 2.5 minutes at a steady flow |
| Tap / sink | under 3 minutes |

The first ticked one that fits, in this order, wins. A use that fits none of them, and water the
meter counts beyond the uses, is **Other**, so the categories add up to the house total. For each
category and Other the device shows its water today and this month and, with a water price, its
cost today and this month (litres at the water price; the base fee is only in the house's cost).

The tiles come in this order: the house's water and cost, Flow and Last use, then each category's
four tiles in the order above, and Other last. Tiles can't be moved in the Homey app, so when a
category is ticked later (or a water price is set after the categories), the device adds the
tiles after it again in order; those tiles start a new insights history.

**Last use** starts with the category, for example *Shower 07:42 - 07:47, 38 l at 7.6 l/min*.

### Correct a category

The buttons **Last use was Shower**, **Last use was Toilet** and so on (one per ticked water use)
correct the category: of the use going on, or of the last use when it ended at most 15 minutes ago.
Its litres move to the new category, today and this month. Pressed again, it moves again. The
corrections are kept to learn the home's own patterns later.

## Flow cards

- Trigger **Water use started** (flow).
- Trigger **Water use ended** (litres, minutes, average flow, cost, category; cost 0 without a
  water price).
- Homey's own cards for the water today and this month, the flow and the costs.
