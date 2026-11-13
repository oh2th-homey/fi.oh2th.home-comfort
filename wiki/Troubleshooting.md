# Troubleshooting

- **"No temperature, off"**: the zone has relays but no working temperature sensor. Check that
  the sensor is available in Homey.
- **"Controller missing"**: the controller is unavailable or removed. After one hour the zones
  heat to comfort, ignore prices and show a problem.
- **Outdoor temperature is empty**: the sensor is unavailable or has not reported for 3 hours.
  Zones keep their last outdoor decision. Check the sensor, or pick another with Repair.
- **No new prices**: the controller's reason starts with `Power by the Hour:` and says why, for
  example it is not installed, older than version 9, or the chosen price device is gone. The
  prices it already has are kept. Update Power by the Hour, or choose another price device with
  Repair.
- **Prices rejected** (deprecated Import prices card only): the controller's reason says why, for
  example today's prices with too few values. The previous prices are kept.
- **A thermostat does not keep its setpoint, or falls back to 4 °C**: the zone writes it again,
  then tries once with a whole degree. If that fails too, the zone shows a problem, fires
  **Member write failed** and tries again later. If the device only takes whole degrees, set its
  **Step** to 1 in Repair.

To see what a zone is doing and why, check its **Reason**
(see [See why a zone does what it does](How-to#see-why-a-zone-does-what-it-does)).
