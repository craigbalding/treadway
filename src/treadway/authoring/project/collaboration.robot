*** Settings ***
Documentation    Distinct principals collaborate; refusal requires actual application responses and independent state observations.
Library          collaborative_flow.CollaborativeFlow
Library          treadway.credentials_robot.CredentialLibrary    ${CURDIR}/identities.json
Test Setup       Open Collaborative Run
Test Teardown    Close Collaborative Run

*** Test Cases ***
Create Refuse Self Approval Approve As Another Principal Then Observe
    ${a}=    Open Fixture Identity    author    casey
    ${b}=    Open Fixture Identity    reviewer    sam
    ${request}=    Create Shared Request    ${a}
    Attempt Self Approval And Verify Refusal    ${a}    ${request}
    ${approved}=    Approve Shared Request    ${b}    ${request}
    Observe Approved Request    ${a}    ${approved}    ${b}

Known Private ID Does Not Grant Access To Another Principal Or Anonymous Session
    ${a}=    Open Fixture Identity    owner    casey
    ${b}=    Open Fixture Identity    colleague    sam
    ${guest1}=    Open Actor    visitor-one
    ${guest2}=    Open Actor    visitor-two
    ${private}=    Create Private Resource    ${a}
    ${control}=    Create Private Resource    ${b}
    Verify Private Access    ${a}    ${private}
    Verify Private Access    ${b}    ${control}
    Attempt Private Access And Verify Refusal    ${b}    ${private}
    Attempt Private Access And Verify Refusal    ${guest1}    ${private}
    Attempt Private Access And Verify Refusal    ${guest2}    ${private}

*** Keywords ***
Open Fixture Identity
    [Arguments]    ${session}    ${identity}
    ${username}=    Get Credential    ${identity}    username
    ${password}=    Get Credential    ${identity}    password
    ${actor}=    Open Authenticated Actor    ${session}    ${identity}    ${username}    ${password}
    RETURN    ${actor}
