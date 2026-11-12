'use strict';
function controlledBinding(snapshot,fieldRef){
  const field=snapshot.fields.find(item=>item.ref===fieldRef);
  if(!field||field.role!=='combobox'||field.choiceUsable!==true)throw new Error('choice_field_not_usable');
  if(!field.controlledElements?.length||field.controlledElements.some(target=>target.matchCount!==1))throw new Error('choice_control_target_missing_or_ambiguous');
  const lists=snapshot.listboxes.filter(list=>list.controllers?.some(controller=>controller.fieldRef===fieldRef));
  if(lists.length!==1)throw new Error('choice_listbox_missing_or_ambiguous');
  const list=lists[0],controllers=list.controllers.filter(controller=>controller.fieldRef===fieldRef);
  if(controllers.length!==1)throw new Error('choice_controller_ambiguous');
  const controller=controllers[0],target=field.controlledElements.find(item=>item.controlId===controller.controlId);
  if(!target||target.disabled||list.disabled)throw new Error('choice_not_usable');
  return {field,list,controller,target,binding:{fieldRef:controller.fieldRef,controlId:controller.controlId,containerRef:controller.containerRef,listboxRef:list.ref}};
}
function choiceContext(snapshot,fieldRef,optionRef){
  const context=controlledBinding(snapshot,fieldRef);
  const option=context.list.options.find(item=>item.ref===optionRef);
  if(!option)throw new Error('select_an_observed_option_reference');
  if(!option.visible||option.disabled)throw new Error('choice_not_usable');
  return {option,binding:context.binding};
}
module.exports={controlledBinding,choiceContext};
