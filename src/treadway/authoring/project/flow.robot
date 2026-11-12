*** Settings ***
Documentation    Synthetic create, exact-ID owner selection, guarded plan commit, independent SQLite readback and reload.
Library          adapter.ReferenceFlow
Test Setup       Open Reference Run
Test Teardown    Cleanup Reference Items

*** Test Cases ***
Create Assign Schedule And Verify After Reload
    ${item}=    Create Work Item    Synthetic onboarding request
    ${plan}=    Prepare Work Item Plan    ${item}    Casey Rowan    2026-12-07    2026-12-11    Please prepare the synthetic onboarding materials.
    ${saved}=    Commit Work Item Plan    ${plan}
    Reload And Verify Work Item    ${saved}    ${plan}[expected]

Stale Revision Blocks The Plan Without A Write
    ${item}=    Create Work Item    Synthetic concurrent request
    ${plan}=    Prepare Work Item Plan    ${item}    Sam Morgan    2026-12-14    2026-12-18    This draft must remain uncommitted after a competing write.
    ${competing}=    Advance Fixture Revision    ${item}
    Run Keyword And Expect Error    *resource_revision_changed_inspect_again*    Commit Work Item Plan    ${plan}
    Verify No Plan Write    ${item}    ${competing}[revision]
