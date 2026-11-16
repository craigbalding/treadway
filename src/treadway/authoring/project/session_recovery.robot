*** Settings ***
Documentation    Renew app authentication during 100 mutations; reconcile a lost response without a duplicate write.
Library          session_recovery.SessionRecoveryExample
Suite Setup      Open Recovery Example
Suite Teardown   Close Recovery Example

*** Test Cases ***
Maintain The Same Identity Across Repeated Mutations
    FOR    ${index}    IN RANGE    1    101
        ${receipt}=    Execute Recovery Binding    ${index}
        Should Be Equal    ${receipt}[state]    confirmed
    END
    ${again}=    Execute Recovery Binding    38
    Should Be Equal    ${again}[state]    confirmed
    ${effects}=    Verify Recovery Effects
    Should Be Equal As Integers    ${effects}[confirmed]    100
    Should Be Equal As Integers    ${effects}[writes]    100
    Should Be Equal As Integers    ${effects}[renewals]    1
