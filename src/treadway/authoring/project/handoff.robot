*** Settings ***
Documentation    Same-item onboarding handoff, independent persisted fields and write count, stale-binding native-step refusal, and scoped cleanup.
Library          adapter.ReferenceFlow
Library          Collections
Test Setup       Open Reference Run
Test Teardown    Cleanup Reference Items

*** Test Cases ***
Hand The Same Onboarding Item From Casey To Sam And Refuse Old Binding
    ${item}=    Create Work Item    Synthetic onboarding for the research intake team
    ${casey}=    Prepare Work Item Plan    ${item}    Casey Rowan    2027-01-04    2027-01-08    Casey: prepare access and the onboarding checklist; send the handoff to Sam.
    ${first}=    Commit Work Item Plan    ${casey}
    &{casey_expected}=    Create Dictionary    ownerId=person-17    start=2027-01-04    due=2027-01-08    note=Casey: prepare access and the onboarding checklist; send the handoff to Sam.
    Reload And Verify Work Item    ${first}    ${casey_expected}
    &{first_persisted}=    Copy Dictionary    ${casey_expected}
    Set To Dictionary    ${first_persisted}    writes=${1}
    Verify Work Item    ${first}    ${first_persisted}
    ${sam}=    Prepare Work Item Plan    ${first}    Sam Morgan    2027-01-11    2027-01-15    Sam: confirm access, run the orientation, and close the onboarding checklist.
    ${current}=    Commit Work Item Plan    ${sam}
    Should Be Equal    ${item}[id]    ${first}[id]
    Should Be Equal    ${first}[id]    ${current}[id]
    &{sam_expected}=    Create Dictionary    ownerId=person-29    start=2027-01-11    due=2027-01-15    note=Sam: confirm access, run the orientation, and close the onboarding checklist.
    Reload And Verify Work Item    ${current}    ${sam_expected}
    &{final_persisted}=    Copy Dictionary    ${sam_expected}
    Set To Dictionary    ${final_persisted}    writes=${2}
    Verify Work Item    ${current}    ${final_persisted}
    Set Suite Variable    ${following_native_step_ran}    ${False}
    Run Keyword And Expect Error    *issued_current_binding_required*    Reuse Old Plan Before Following Native Step    ${casey}
    Should Be Equal    ${following_native_step_ran}    ${False}
    Reload And Verify Work Item    ${current}    ${sam_expected}
    Verify Work Item    ${current}    ${final_persisted}

*** Keywords ***
Reuse Old Plan Before Following Native Step
    [Arguments]    ${old_plan}
    Commit Work Item Plan    ${old_plan}
    Set Suite Variable    ${following_native_step_ran}    ${True}
