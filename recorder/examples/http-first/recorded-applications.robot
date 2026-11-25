*** Settings ***
Documentation    Actual unpacked-extension capture mapped to a calibrated local HTTP flow.
Library          RecordedApplicationLibrary.py

*** Test Cases ***
Replay Actual Recording With A Fresh Principal
    Configure Recorded Application    ${ORIGIN}    ${CAPTURE}    fresh-fixture-person
    ${application}=    Create Recorded Application Once
    Observe Recorded Application    ${application}

Wrong Principal Does Not Replay The Mutation
    Configure Recorded Application    ${ORIGIN}    ${CAPTURE}    fresh-fixture-person    another-fixture-person
    Run Keyword And Expect Error    HttpFailure: actual_principal_differs*    Create Recorded Application Once
