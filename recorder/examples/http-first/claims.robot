*** Settings ***
Documentation    Synthetic capture-to-HTTP conversion with independent persistence readback.
Library          ClaimLibrary.py

*** Test Cases ***
Replay With First Fresh Persona
    Configure Fixture    ${ORIGIN}    casey-fresh
    Verify Capture Mapping
    ${claim}=    Create Claim Once    17
    Observe Persisted Claim    ${claim}

Replay With Second Fresh Persona
    Configure Fixture    ${ORIGIN}    sam-fresh
    ${claim}=    Create Claim Once    29
    Observe Persisted Claim    ${claim}

Wrong Actual Principal Stops Before Creation
    Configure Fixture    ${ORIGIN}    sam-fresh    casey-fresh
    Run Keyword And Expect Error    HttpFailure: actual_principal_differs*    Create Claim Once    41
