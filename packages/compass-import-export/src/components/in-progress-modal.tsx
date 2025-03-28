import React from 'react';
import { connect } from 'react-redux';
import {
  Button,
  Modal,
  ModalFooter,
  ModalHeader,
} from '@mongodb-js/compass-components';

import { closeInProgressMessage } from '../modules/import';
import type { RootImportState } from '../stores/import-store';

type InProgressModalProps = {
  closeInProgressMessage?: () => void;
  isInProgressMessageOpen: boolean;
};

function InProgressModal({
  closeInProgressMessage,
  isInProgressMessageOpen,
}: InProgressModalProps) {
  return (
    <Modal
      open={isInProgressMessageOpen}
      setOpen={closeInProgressMessage}
      data-testid="import-modal"
    >
      <ModalHeader
        title="Sorry, currently only one import operation is possible at a time"
        subtitle="Import is disabled as there is an import already in progress."
      />
      <ModalFooter>
        <Button onClick={closeInProgressMessage}>Cancel</Button>
      </ModalFooter>
    </Modal>
  );
}

const mapStateToProps = (state: RootImportState) => ({
  isInProgressMessageOpen: state.importData.isInProgressMessageOpen,
});
export default connect(mapStateToProps, {
  closeInProgressMessage,
})(InProgressModal);
