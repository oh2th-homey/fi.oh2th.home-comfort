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

Then tick the **Water uses** the home has: **Shower**, **Sink** (a kitchen or utility room
sink), **Washroom** (a toilet visit: the flush, and washing hands after it), **Bath** and
**Outdoor tap** (they need a meter with a flow). See [Categories](#categories).

Pick another meter or change the water uses in the device's **Repair**. Today's and this month's
litres are kept.

## What it shows

- **Water today** (l), **Water this month**, **Water last month**, **Water this year** and
  **Water last year** (m³). Today starts from zero at midnight, this month on the first day of the
  month, this year on 1 January.
- **Water cost this month**, **last month**, **this year** and **last year**, when a
  [water price or base fee](#settings) is set.
- The same for each category and Unknown (see [Categories](#categories)).
- **Flow** now (l/min).
- **Last use**: the use going on (*Running since 07:42 - 12 l*) or the last one
  (*07:42 - 07:47, 38 l at 7.6 l/min*).

## Settings

- **Water price** (per m³): supply and wastewater together, as on the water bill (with VAT if you
  pay it). The litres are counted at this price, so a new price applies to the whole month. A month
that has ended keeps the price and fee it had, in last month's and the years' costs.
- **Base fee** (per month): the bill's fixed fee, spread evenly over the month's days. This month's
  cost has the shares of the days so far; an ended month has the whole fee.

Both are in the Home Controller's currency; 0 leaves them out. A use's cost (**Water use ended**)
is its litres at the water price, without the base fee.

**Reset counters** (the device's settings, **Maintenance actions**) sets all the water and cost
counters to zero (also last month and the years), and clears Last use. It can't be undone. The
insights are kept, and so are the learned uses: the categories keep their patterns. The base
fee's share of the days so far stays in this month's and this year's cost.

## Uses

A use starts when water starts running and ends a minute after it stops: a short pause in a
shower is still the same shower, while a washing machine's fills a few minutes apart are separate
uses. **Last use** shows the use as finished as soon as the water stops; it is counted, and
**Water use ended** runs, after that minute.

Some meters report a small flow while no water passes, for example an ultrasonic meter some time
after a use. So a use counts only once the meter reading has moved by a litre: **Water use
started** runs then, and a flow that ends before that is ignored. A meter with only a flow can't be
checked like this; its uses count as soon as the flow rises.

The meter sees all the home's water, so two uses at the same time (a tap while a shower runs)
count as one.

## Categories

A use is **Unknown** until it is labelled: press **Last use was Shower**, **Last use was Washroom**
and so on (one button per ticked water use) during the use, or at most 15 minutes after it ended.
Its litres move to that category, today and this month. Pressed again, it moves again. Pressed
while the water runs, **Last use** shows the category at once (*Shower running since 07:42 - 12 l*)
and the litres move when the use ends, a minute after the water stops.

Each category learns from its labelled uses: the litres, length, average and peak flow. After
three labels of a category, a new use that is like its nearest labelled uses, all of one category,
is counted in it by itself. A use like none of them, or like uses of two categories, stays Unknown
until it is labelled. A category can have several kinds of use: a washroom visit with an eco or a
full flush, with or without washing hands, all learned under the one **Washroom** button.

A washroom visit is one use: the cistern refills for about a minute, and washing hands meanwhile
or right after (the water stopped for less than a minute) adds to the same use.

An automatically counted use teaches its category too, so the patterns get better with use. If it
went to the wrong category, move it with the buttons: it then teaches the right one instead. Pressing
the category it already has confirms it. Each category learns from its latest 30 uses.

Unknown also holds the water the meter counts beyond the uses, so the categories add up to the
house total. For each category and Unknown the device shows the same water and costs as for the
house (litres at the water price; the base fee is only in the house's cost).

Flow and Last use come first. Then the tiles are grouped by what they show: water today, water this month, cost this month, water
last month, cost last month, water this year, cost this year, water last year and cost last year.
Each group has the house's tile first, then the categories in the pairing order, and Unknown last.
The Last use was buttons come after them. Tiles can't be moved in the Homey
app, so when a category is ticked later (or a water price is set after the categories), the
device adds the tiles after it again in order. Their insights are kept: a tile added again
continues its history.

**Last use** starts with the category, for example *Shower 07:42 - 07:47, 38 l at 7.6 l/min*.

### A button next to the use point

The flow action **Last use was [category]** does the same as the device's buttons. With a
wireless button next to the shower or in the washroom, a flow *When the button is pressed, then Last
use was Shower* labels the use without opening the Homey app.

## Flow cards

- Trigger **Water use started** (flow).
- Trigger **Water use ended** (litres, minutes, average flow, cost, category; cost 0 without a
  water price).
- Action **Last use was [category]**: labels the use going on or the last one, see
  [A button next to the use point](#a-button-next-to-the-use-point).
- Homey's own cards for the water today and this month, the flow and the costs.
