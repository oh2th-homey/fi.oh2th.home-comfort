'use strict';

exports.init = async function (ctx) {
  /**
   * HVAC Controller conditions
   */
  const onCondition_ENUM_OCCUPANCY_IS = ctx.homey.flow.getConditionCard('enum_occupancy_is');
  onCondition_ENUM_OCCUPANCY_IS.registerRunListener(async (args, state) => args.device.getCapabilityValue('enum_occupancy') === args.occupancy);

  const onCondition_IS_EXPENSIVE = ctx.homey.flow.getConditionCard('is_expensive');
  onCondition_IS_EXPENSIVE.registerRunListener(async (args, state) => args.device.getCapabilityValue('is_expensive') === true);

  const onCondition_IS_LONG_ABSENCE = ctx.homey.flow.getConditionCard('is_long_absence');
  onCondition_IS_LONG_ABSENCE.registerRunListener(async (args, state) => args.device.getCapabilityValue('is_long_absence') === true);

  /**
   * Heating Zone conditions
   */
  const onCondition_ENUM_ZONE_MODE_IS = ctx.homey.flow.getConditionCard('enum_zone_mode_is');
  onCondition_ENUM_ZONE_MODE_IS.registerRunListener(async (args, state) => args.device.getCapabilityValue('enum_zone_mode') === args.mode);

  const onCondition_IS_ECO = ctx.homey.flow.getConditionCard('is_eco');
  onCondition_IS_ECO.registerRunListener(async (args, state) => args.device.getCapabilityValue('is_eco') === true);

  /**
   * Hot Tub and Water Heater conditions
   */
  const onCondition_ENUM_WATER_STATE_IS = ctx.homey.flow.getConditionCard('enum_water_state_is');
  onCondition_ENUM_WATER_STATE_IS.registerRunListener(async (args, state) => args.device.getCapabilityValue('enum_water_state') === args.state);

  const onCondition_HEATING_READY = ctx.homey.flow.getConditionCard('heating_ready');
  onCondition_HEATING_READY.registerRunListener(async (args, state) => args.device.getCapabilityValue('heating_ready') === true);

  const onCondition_IS_HEATING_DEMAND = ctx.homey.flow.getConditionCard('is_heating_demand');
  onCondition_IS_HEATING_DEMAND.registerRunListener(async (args, state) => args.device.getCapabilityValue('is_heating_demand') === true);
};
